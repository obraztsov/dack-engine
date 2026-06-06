//! Operator control plane + config (PRD §8.2) — the non-LLM authority surface.
//!
//! A rich YAML the operator owns and the harness reads (hot-reloadable). Holds the
//! routing table, the control plane (cap/whitelist — future), forwarded-env *names*,
//! secret *references* (names/paths, never values), and the trusted operator DID.
//! The agent may *read* select fields (it should know it can be killed) but can
//! **never write** this — it is operator writer-of-record (PRD §7.1).

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{DackError, Result};
use crate::model::stimulus::{Priority, StimulusType, TrustTier};

/// Coalescing policy — both an economics knob and a character decision (architecture §3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoalescePolicy {
    pub mode: CoalesceMode,
    #[serde(default)]
    pub window_sec: Option<u64>,
    #[serde(default)]
    pub dedup_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoalesceMode {
    /// Batch within a window keyed by `dedup_key` (50 mentions → 1 wake).
    Batch,
    /// Keep only the latest per `dedup_key`.
    Latest,
    /// One-at-a-time; each candidate judged individually (e.g. token launches).
    None,
}

/// The entry into the consciousness loop for a matched route.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryState {
    Perceive,
    /// Baseline cadence: Perceive then immediately Express (e.g. scheduled posts).
    PerceiveThenExpress,
}

/// One routing rule: `(payload_tier, type)` → entry state + priority + coalesce policy.
/// Fixed states, configurable edges — the product-iteration surface. The agent never
/// edits this and never assigns its own tiers (PRD §5.6).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingRule {
    #[serde(rename = "match")]
    pub match_: RouteMatch,
    pub entry: EntryState,
    #[serde(default)]
    pub priority: Option<Priority>,
    #[serde(default)]
    pub coalesce: Option<CoalescePolicy>,
    /// Secrets-provider scopes the **act (Express/Settle) phase** of cycles matching this route
    /// may use (by provider `name`). **Operator-controlled** — the agent can't grant itself a
    /// secret; it can only select from the operator's `secrets_providers`. Materialized by the
    /// harness when opening Express; the read-only **Perceive never receives these** (PRD §7.2,
    /// §4.1; `docs/SECRETS-AND-SANDBOX.md`).
    #[serde(default)]
    pub secrets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteMatch {
    pub tier: TrustTier,
    #[serde(rename = "type")]
    pub type_: StimulusType,
}

/// The control plane the Settle predicate reads (PRD §7.6, §8.2). v1: empty/zeroed —
/// no Settle wired. **Amount/cap is enforced by the DAC treasury, not duplicated here**
/// (PRD §7.6); `cap_remaining` is retained only as a future operator-visible field.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ControlPlane {
    #[serde(default)]
    pub cap_remaining: u64,
    /// Whitelisted contracts — set membership, the dumb half of `allow_settle`.
    #[serde(default)]
    pub whitelist: Vec<String>,
    #[serde(default)]
    pub allowed_action_types: Vec<String>,
}

/// One secrets provider (a trusted, harness-owned script) — see [`DackConfig::secrets_providers`].
/// The `command` is run with `env` (its config — e.g. creds-file/token-store paths) injected;
/// it prints a JSON object `{"ENV_KEY": "value", …}` on stdout that the harness injects into
/// the consumer that declared this provider's `name`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretsProviderConfig {
    pub name: String,
    /// argv of the provider script, e.g. `["python3", "secrets-providers/x_oauth2.py"]`.
    pub command: Vec<String>,
    /// Config env passed to the script (paths/refs — NOT secret values).
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Env keys this provider is expected to emit (documentation / validation; optional).
    #[serde(default)]
    pub keys: Vec<String>,
}

/// `dack.config.yaml` (PRD §8.2). Hot-reloadable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DackConfig {
    /// The trusted operator DID — provenance check for `operator_signed` (PRD §5.7).
    pub operator_did: String,
    #[serde(default)]
    pub routing: Vec<RoutingRule>,
    /// Names listed here are injected into the agent + sensor env. Reserved for
    /// recoverable/non-catastrophic values (API keys, handle, limits) — PRD §7.2.
    #[serde(default)]
    pub forwarded_env: Vec<String>,
    /// References only — values live in a separate secret store the YAML never inlines
    /// (so config is inspectable without exposing keys). The Soul DID key is here as a
    /// `file://` ref and is **never** forwarded to the agent (PRD §7.2, §8.2).
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
    /// **Secrets providers** — trusted, harness-owned scripts that materialize a short-lived
    /// token env on demand (fetch + validity-check + rotate-only-when-needed). A duty/skill
    /// references a provider by `name` in its `secrets:` list; the harness runs the provider
    /// command and injects its JSON output. Adding a new secret (X, cove.trade, …) is a YAML
    /// entry + a script — **never a harness change** (PRD §7.2; `docs/SECRETS-AND-SANDBOX.md`).
    #[serde(default)]
    pub secrets_providers: Vec<SecretsProviderConfig>,
    #[serde(default)]
    pub control_plane: ControlPlane,
    /// Cron schedule for the harness-entered Reflect run (PRD §4.2). `None` = manual
    /// (`dack reflect-now`) only.
    #[serde(default)]
    pub reflect_schedule: Option<String>,
    /// Path to the soul repo / actor bundle on the box (holds `stimuli/`, `SOUL.md`, …).
    #[serde(default = "default_soul_repo")]
    pub soul_repo: String,
    /// Embedded SQLite queue path (ephemeral; PRD §9.3). Losing it loses only the queue.
    #[serde(default = "default_db_path")]
    pub db_path: String,
    /// Localhost bind for the webhook listener (PRD §2 — nothing public without a proxy).
    #[serde(default = "default_webhook_addr")]
    pub webhook_addr: String,
    /// Path to the `openclaude-bridge/` project the runtime runs (`bun run bridge.ts`) —
    /// the TS side of the runtime seam (depends on `@gitlawb/openclaude` from npm).
    #[serde(default = "default_bridge_dir")]
    pub bridge_dir: String,
    /// Model id passed to the engine as `options.model` — only for models in the SDK's own
    /// catalog (Anthropic tiers). **For an OpenAI-compatible gateway (opengateway/mimo,
    /// Ollama, …) leave this `None` and set `OPENAI_MODEL` via `runtime_env`** — the SDK
    /// resolves `options.model` against its catalog and rejects unknown gateway names
    /// (live-verified, Phase 4).
    #[serde(default)]
    pub model: Option<String>,
    /// Env var *names* forwarded into the runtime bridge — the provider key, base URL, and
    /// model name live here (values come from the harness env, never the YAML). **Soul key
    /// never listed.**
    #[serde(default = "default_runtime_env")]
    pub runtime_env: Vec<String>,
}

fn default_soul_repo() -> String {
    ".".to_string()
}
fn default_db_path() -> String {
    "dack.sqlite".to_string()
}
fn default_webhook_addr() -> String {
    "127.0.0.1:8787".to_string()
}
fn default_bridge_dir() -> String {
    "openclaude-bridge".to_string()
}
fn default_runtime_env() -> Vec<String> {
    vec![
        "OPENAI_API_KEY".to_string(),
        "OPENAI_BASE_URL".to_string(),
        "OPENAI_MODEL".to_string(),
    ]
}

impl DackConfig {
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let text = std::fs::read_to_string(path)?;
        Self::from_yaml(&text)
    }

    pub fn from_yaml(text: &str) -> Result<Self> {
        serde_yaml::from_str(text).map_err(DackError::from)
    }

    /// Look up the routing rule for a `(payload_tier, type)` pair. Returns the first
    /// match (operator authoring order is significant).
    pub fn lookup_route(&self, tier: TrustTier, type_: &StimulusType) -> Option<&RoutingRule> {
        self.routing
            .iter()
            .find(|r| r.match_.tier == tier && &r.match_.type_ == type_)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
operator_did: "did:key:z6MkOperator"
routing:
  - match: { tier: public, type: mention }
    entry: perceive
    priority: low
    coalesce: { mode: batch, window_sec: 300, dedup_key: thread_id }
  - match: { tier: self, type: scheduled_post }
    entry: perceive_then_express
forwarded_env: [TWITTER_API_KEY, BANKR_API_KEY, BUILDER_DID_KEY, DACK_HANDLE, RATE_LIMIT]
secrets:
  soul_did_key: "file:///run/secrets/soul_did_key"
control_plane:
  cap_remaining: 0
  whitelist: []
  allowed_action_types: []
"#;

    #[test]
    fn parses_sample_config() {
        let cfg = DackConfig::from_yaml(SAMPLE).expect("config parses");
        assert_eq!(cfg.operator_did, "did:key:z6MkOperator");
        assert_eq!(cfg.routing.len(), 2);
        assert!(cfg.forwarded_env.contains(&"TWITTER_API_KEY".to_string()));
        // Soul key is a reference, never forwarded.
        assert!(cfg.secrets.contains_key("soul_did_key"));
        assert!(!cfg.forwarded_env.contains(&"SOUL_DID_KEY".to_string()));
    }

    #[test]
    fn routes_public_mention_to_perceive() {
        let cfg = DackConfig::from_yaml(SAMPLE).unwrap();
        let rule = cfg
            .lookup_route(TrustTier::Public, &StimulusType::from("mention"))
            .expect("mention route exists");
        assert_eq!(rule.entry, EntryState::Perceive);
        // No row routes a public tier to settle — verify nothing escalates.
        assert!(cfg
            .lookup_route(TrustTier::Public, &StimulusType::from("token_launch"))
            .is_none());
    }
}
