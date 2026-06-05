//! The stimulus registry (PRD §5.1–§5.4). **The `stimuli/` directory IS the agent's
//! job description**: each `.md` is a *standing duty* the agent performs when triggered,
//! carrying its own briefing text. A set of duty-stimuli is a decomposed job
//! description — the unit that generalizes to future firm actors.
//!
//! Registration convention: walk `stimuli/` to **max depth 2**; every `.md` (depth ≤ 2)
//! is a stimulus definition. Sensors live in a sibling `scripts/`. The `.md`'s
//! **frontmatter is config**; its **body is the directive text** (trusted, PRD §5.3).
//! `stimuli/` is writable only in Reflect — so this is gated self-evolution of the
//! duck's own senses and duties.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::{CoalescePolicy, EntryState};
use crate::error::{DackError, Result};
use crate::model::stimulus::{Priority, StimulusType, TrustTier};

/// Trigger that fires a duty (PRD §5.1). `cron` (re)schedules a timer; `webhook`
/// registers a listener on the fly. The Twitter push-path swap (PRD §10.2) is just
/// flipping `cron` → `webhook` here — no architectural change.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Trigger {
    Cron { schedule: String },
    Webhook { path: String },
}

/// What rows this duty emits (PRD §5.4 `emits:`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Emits {
    #[serde(rename = "type")]
    pub type_: StimulusType,
    /// Tier carried by sensor output items unless a candidate overrides it.
    pub default_payload_tier: TrustTier,
}

/// The YAML frontmatter of a `STIMULUS.md` (PRD §5.4).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StimulusFrontmatter {
    pub id: String,
    pub trigger: Trigger,
    /// Path to the sensor executable (resolved into the sibling `scripts/`). Omit for a
    /// pure-cron self-prompt. **Honored only for trusted directive tiers** (PRD §5.2).
    #[serde(default)]
    pub sensor: Option<String>,
    /// Trust tier of THIS `.md` body (trusted intent): `self` | `operator_signed`.
    pub directive_tier: TrustTier,
    pub emits: Emits,
    #[serde(default)]
    pub coalesce: Option<CoalescePolicy>,
    pub route: EntryState,
    #[serde(default)]
    pub priority: Option<Priority>,
}

/// A registered duty: parsed frontmatter + the trusted directive body.
#[derive(Debug, Clone)]
pub struct StimulusDef {
    pub frontmatter: StimulusFrontmatter,
    /// The `.md` body — the trusted briefing appended to Perceive context (PRD §5.5.6).
    pub directive_body: String,
    /// Repo-relative path the def was loaded from (used for the trusted-dir check).
    pub source_path: String,
}

/// Split a `---`-delimited frontmatter document into (yaml, body). Returns an error if
/// the leading `---` fence is missing or unterminated.
pub fn split_frontmatter(text: &str) -> Result<(&str, &str)> {
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))
        .ok_or_else(|| DackError::Stimulus("missing leading `---` frontmatter fence".into()))?;
    // Find the closing fence at the start of a line.
    let end = rest
        .find("\n---\n")
        .or_else(|| rest.find("\n---\r\n"))
        .ok_or_else(|| DackError::Stimulus("unterminated frontmatter fence".into()))?;
    let yaml = &rest[..end];
    // Body starts after the closing fence line.
    let after = &rest[end..];
    let body = after
        .strip_prefix("\n---\n")
        .or_else(|| after.strip_prefix("\n---\r\n"))
        .unwrap_or("");
    Ok((yaml, body.trim_start()))
}

impl StimulusDef {
    /// Parse one `STIMULUS.md` from its raw text + repo path.
    pub fn parse(text: &str, source_path: impl Into<String>) -> Result<Self> {
        let (yaml, body) = split_frontmatter(text)?;
        let frontmatter: StimulusFrontmatter = serde_yaml::from_str(yaml)?;
        Ok(StimulusDef {
            frontmatter,
            directive_body: body.to_string(),
            source_path: source_path.into(),
        })
    }

    /// Whether this def's `sensor` reference is honored (trusted directive tier).
    /// The trusted-*dir* half is enforced at registration (only trusted repo dirs are
    /// walked); this is the tier half (PRD §5.2/§5.3).
    pub fn sensor_honored(&self) -> bool {
        crate::sensor::scripts_honored(self.frontmatter.directive_tier)
    }

    /// Absolute path to this duty's sensor executable, if it declares one **and** its
    /// directive tier honors scripts (PRD §5.2). Resolved relative to the duty's own
    /// directory (the dir holding the `.md`), so `sensor: ./scripts/x.sh` lands in the
    /// sibling `scripts/`. `None` for pure-cron self-prompts or untrusted tiers.
    pub fn resolved_sensor(&self, repo_root: impl AsRef<Path>) -> Option<PathBuf> {
        if !self.sensor_honored() {
            return None;
        }
        let rel = self.frontmatter.sensor.as_ref()?;
        let md_abs = repo_root.as_ref().join(&self.source_path);
        Some(md_abs.parent()?.join(rel))
    }
}

/// Maximum file-depth the registry walks under `stimuli/` (PRD §5.1): a file directly in
/// `stimuli/` is depth 1, so `MAX_DEPTH = 2` admits the `stimuli/<duty>/STIMULUS.md`
/// convention and excludes anything more deeply nested.
pub const MAX_DEPTH: usize = 2;

/// The registered set of duties — **the agent's job description** (PRD §5.1) — plus any
/// per-file parse errors. A malformed duty is **skipped, not fatal**: one bad `.md` must
/// not blind the duck to all its other senses (logging-not-rollback, PRD §7.5). The
/// registry is rebuilt on each `stimuli/` change (hot-reload).
#[derive(Debug, Default)]
pub struct Registry {
    pub defs: Vec<StimulusDef>,
    /// `(repo-relative path, error)` for each `.md` that failed to parse.
    pub errors: Vec<(String, String)>,
}

impl Registry {
    /// Walk `<repo_root>/stimuli/` to file-depth ≤ [`MAX_DEPTH`], parsing every `.md`.
    /// Only `stimuli/` is walked — the **trusted-dir** half of the sensor gate (PRD §5.2):
    /// nothing outside the duck's own repo can register a duty or a script.
    pub fn load(repo_root: impl AsRef<Path>) -> Result<Registry> {
        let repo_root = repo_root.as_ref();
        let mut reg = Registry::default();
        let stimuli = repo_root.join("stimuli");
        if stimuli.is_dir() {
            reg.walk(&stimuli, repo_root, 1);
        }
        Ok(reg)
    }

    fn walk(&mut self, dir: &Path, repo_root: &Path, file_depth: usize) {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(e) => {
                self.errors.push((rel(dir, repo_root), e.to_string()));
                return;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if file_depth < MAX_DEPTH {
                    self.walk(&path, repo_root, file_depth + 1);
                }
            } else if file_depth <= MAX_DEPTH
                && path.extension().and_then(|e| e.to_str()) == Some("md")
            {
                let source_path = rel(&path, repo_root);
                match std::fs::read_to_string(&path)
                    .map_err(DackError::from)
                    .and_then(|t| StimulusDef::parse(&t, source_path.clone()))
                {
                    Ok(def) => self.defs.push(def),
                    Err(e) => self.errors.push((source_path, e.to_string())),
                }
            }
        }
    }

    pub fn get(&self, def_id: &str) -> Option<&StimulusDef> {
        self.defs.iter().find(|d| d.frontmatter.id == def_id)
    }

    /// `(def_id, cron_schedule)` for every cron-triggered duty — feeds the scheduler.
    pub fn cron_routes(&self) -> Vec<(String, String)> {
        self.defs
            .iter()
            .filter_map(|d| match &d.frontmatter.trigger {
                Trigger::Cron { schedule } => Some((d.frontmatter.id.clone(), schedule.clone())),
                Trigger::Webhook { .. } => None,
            })
            .collect()
    }

    /// `(path, def_id)` for every webhook-triggered duty — feeds the listener.
    pub fn webhook_routes(&self) -> Vec<(String, String)> {
        self.defs
            .iter()
            .filter_map(|d| match &d.frontmatter.trigger {
                Trigger::Webhook { path } => Some((path.clone(), d.frontmatter.id.clone())),
                Trigger::Cron { .. } => None,
            })
            .collect()
    }
}

/// Repo-relative, forward-slashed path string (the `source_path` form defs are keyed by).
fn rel(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;

    // The §5.4 worked example, verbatim shape.
    const CLARITY: &str = r#"---
id: clarity-reply-guy
trigger: { type: cron, schedule: "0 * * * *" }
sensor: ./scripts/fetch_clarity_posts.sh
directive_tier: self
emits:
  type: clarity_post
  default_payload_tier: public
coalesce: { mode: batch, window_sec: 600, dedup_key: tweet_id }
route: perceive
priority: low
---
Standing directive (trusted): survey new posts discussing the CLARITY act and engage
as a reply-guy, framing DAC's ministerial-management model as the timely fit. Be
selective; skip low-quality bait.
"#;

    #[test]
    fn parses_the_clarity_reply_guy_duty() {
        let def = StimulusDef::parse(CLARITY, "stimuli/clarity-reply-guy/STIMULUS.md").unwrap();
        assert_eq!(def.frontmatter.id, "clarity-reply-guy");
        assert_eq!(def.frontmatter.directive_tier, TrustTier::SelfTier);
        assert_eq!(def.frontmatter.emits.type_, StimulusType::from("clarity_post"));
        assert_eq!(def.frontmatter.emits.default_payload_tier, TrustTier::Public);
        assert!(matches!(def.frontmatter.trigger, Trigger::Cron { .. }));
        assert!(def.frontmatter.sensor.is_some());
        // self-tier directive → sensor honored.
        assert!(def.sensor_honored());
        // Directive body is the trusted briefing, carried separately from payload.
        assert!(def.directive_body.starts_with("Standing directive (trusted):"));
    }

    #[test]
    fn rejects_missing_frontmatter() {
        assert!(StimulusDef::parse("no frontmatter here", "x.md").is_err());
    }

    // ── Registry / walker (Phase 3) ───────────────────────────────────────────

    fn cron_duty(id: &str, sensor: Option<&str>) -> String {
        let sensor_line = sensor.map(|s| format!("sensor: {s}\n")).unwrap_or_default();
        format!(
            "---\nid: {id}\ntrigger: {{ type: cron, schedule: \"0 * * * *\" }}\n{sensor_line}\
             directive_tier: self\nemits:\n  type: t_{id}\n  default_payload_tier: public\n\
             route: perceive\n---\nDirective for {id}.\n"
        )
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    fn temp_repo(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dack-reg-{}-{}", tag, std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn walks_duties_skips_malformed_and_resolves_sensor() {
        let root = temp_repo("walk");
        write(&root, "stimuli/clarity/STIMULUS.md", &cron_duty("clarity", Some("./scripts/fetch.sh")));
        write(&root, "stimuli/heartbeat/STIMULUS.md", &cron_duty("heartbeat", None));
        write(&root, "stimuli/broken/STIMULUS.md", "no frontmatter at all");
        // Too deep (file-depth 3) — must NOT be registered.
        write(&root, "stimuli/a/b/DEEP.md", &cron_duty("deep", None));

        let reg = Registry::load(&root).unwrap();
        assert_eq!(reg.defs.len(), 2, "two valid duties");
        assert_eq!(reg.errors.len(), 1, "broken one skipped + recorded");
        assert!(reg.errors[0].0.contains("broken"));
        assert!(reg.get("deep").is_none(), "depth>2 excluded");

        // Sensor resolves into the duty's sibling scripts/.
        let clarity = reg.get("clarity").unwrap();
        let sensor = clarity.resolved_sensor(&root).unwrap();
        assert!(sensor.ends_with("stimuli/clarity/scripts/fetch.sh"), "{sensor:?}");
        // Pure-cron duty has no sensor.
        assert!(reg.get("heartbeat").unwrap().resolved_sensor(&root).is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn derives_cron_and_webhook_routes() {
        let root = temp_repo("routes");
        write(&root, "stimuli/poller/STIMULUS.md", &cron_duty("poller", None));
        write(
            &root,
            "stimuli/inbox/STIMULUS.md",
            "---\nid: inbox\ntrigger: { type: webhook, path: /hooks/inbox }\n\
             directive_tier: self\nemits:\n  type: msg\n  default_payload_tier: public\n\
             route: perceive\n---\nInbound webhook duty.\n",
        );
        let reg = Registry::load(&root).unwrap();

        let crons = reg.cron_routes();
        assert_eq!(crons, vec![("poller".to_string(), "0 * * * *".to_string())]);
        let hooks = reg.webhook_routes();
        assert_eq!(hooks, vec![("/hooks/inbox".to_string(), "inbox".to_string())]);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn missing_stimuli_dir_is_empty_not_error() {
        let root = temp_repo("empty");
        let reg = Registry::load(&root).unwrap();
        assert!(reg.defs.is_empty() && reg.errors.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }
}
