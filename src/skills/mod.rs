//! Executable skills — operator/soul-**SIGNED** capability packages the duck runs via `RunSkillCommand`
//! (a structured tool: NO shell; fixed argv templates with typed holes; tier/taint-gated at the wall, like
//! an MCP capability). The detached Ed25519 signature over the manifest bytes is the **EXECUTE-GATE**: a
//! manifest that is unsigned, tampered, or signed by neither the operator nor the soul is PROSE-ONLY — the
//! duck may READ it, never run it. (Stimulus signing is a planned extension of the same primitive — deferred.)
//!
//! This module is the PURE skills logic (parse · structural-validate · verify-signature); the wall wiring
//! (tier/taint gating + arg-value validation + argv build → execve) builds on it in the harness.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::config::CapabilityTier;
use crate::error::{DackError, Result};
use crate::model::stimulus::TrustTier;
use crate::identity::ed25519::verify_ed25519_did;
use crate::identity::{Did, Signature};

/// The signed manifest file inside a skill dir; its detached signature is `<MANIFEST_FILE>.sig`.
pub const MANIFEST_FILE: &str = "skill.manifest.yaml";
/// The `${SKILL_DIR}` token in an argv template → the skill's absolute (or guest) dir at build time.
pub const SKILL_DIR_TOKEN: &str = "${SKILL_DIR}";
/// The `${MEDIA_OUT}` token in a `produces: media` command's argv → the HARNESS-fixed output path under the
/// media dir (the model never chooses it). Resolved by [`authorize`], recorded on [`SkillExec::produced_media`]
/// so the bridge reads exactly that file back and turns it into a vision block. Symmetric with `${SKILL_DIR}`.
pub const MEDIA_OUT_TOKEN: &str = "${MEDIA_OUT}";
/// The structured tool the duck calls to run a vetted skill command (input `{skill, command, args}`). Not
/// a shell — the harness verifies + builds the argv and the bridge execve's it.
pub const RUN_SKILL_COMMAND: &str = "RunSkillCommand";

/// The harness-approved execution of a skill command — the wall's output on allow, for the bridge to spawn
/// via execve. Built ONLY after signature-verify + arg-validation (tier-gating is applied by the wall on the
/// [`SkillAuthz::tier`] separately). `argv[0]` is the program; the rest are inert argv elements.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillExec {
    pub argv: Vec<String>,
    /// Secrets-provider `name` this command declared (informational; the materialized value rides `env`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    /// The MATERIALIZED secret env the harness injects into the child (`{ENV_NAME: value}`) — filled by the
    /// wall from the broker on approve; the model never sees it. Empty when the command declares no secret.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Whether the sandboxed child gets network egress.
    pub network: bool,
    /// For a `produces: media` command: the HARNESS-fixed absolute output path the child writes (the resolved
    /// `${MEDIA_OUT}`). The bridge reads exactly this file back on a successful exec and turns it into a vision
    /// block — the model never names it. `None` for a normal (text-output) command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub produced_media: Option<String>,
}

/// What a command's successful run yields, beyond text. `media` ⇒ it writes an image to `${MEDIA_OUT}` which
/// the bridge reads back into a vision block (see [`SkillExec::produced_media`]). Absent ⇒ plain text output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Produces {
    Media,
}

/// A verified, arg-checked skill call: the command's capability tier + taint label (for the wall to gate on)
/// plus the built [`SkillExec`]. Produced by [`authorize`] only after the manifest signature verifies.
#[derive(Debug, Clone)]
pub struct SkillAuthz {
    pub tier: CapabilityTier,
    pub trust: TrustTier,
    pub exec: SkillExec,
}

/// Authorize a `RunSkillCommand { skill, command, args }` against the SIGNED pack: verify the manifest
/// signature (the execute-gate), look up the command, validate the typed args, and build the argv. Returns
/// the command's tier/trust (for the wall to gate by state × taint) + the exec. Any failure — traversal,
/// bad signature, unknown command, bad arg — is an `Err` the wall turns into a Deny. Does NOT itself gate by
/// state/taint; that's the caller's job with the returned `tier`.
pub fn authorize(
    skills_root: &Path,
    skill: &str,
    command: &str,
    args: &BTreeMap<String, String>,
    trusted: &[&Did],
    scope: &BTreeMap<String, String>,
    media_dir: Option<&Path>,
) -> Result<SkillAuthz> {
    // The skill name comes from the MODEL (untrusted). Confine it to a single dir component — no traversal,
    // no separators — so it can only name a dir directly under `skills_root`.
    if skill.is_empty() || skill.contains('/') || skill.contains('\\') || skill.contains("..") {
        return Err(DackError::Config(format!("invalid skill name `{skill}`")));
    }
    let skill_dir = skills_root.join(skill);
    let manifest = load_signed(&skill_dir, trusted)?; // ← the execute-gate (unsigned/tampered/wrong-signer ⇒ Err)
    let cmd = manifest
        .command(command)
        .ok_or_else(|| DackError::Config(format!("skill `{skill}` has no command `{command}`")))?;
    let mut argv = cmd.build_argv(&skill_dir.to_string_lossy(), args, scope)?;

    // A `produces: media` command writes an image to `${MEDIA_OUT}`. The harness — NOT the model — fixes that
    // path under the media dir: a basename-sanitized cache name derived from the (pattern-validated) `ref` arg,
    // so repeat fetches of the same id reuse one file and nothing escapes the dir. Record it for the bridge.
    let produced_media = if cmd.produces == Some(Produces::Media) {
        let dir = media_dir.ok_or_else(|| {
            DackError::Config(format!("skill `{skill}/{command}` produces media but no media dir is configured"))
        })?;
        let out = dir.join(sanitize_media_name(args.get("ref").map(String::as_str).unwrap_or("")));
        let out_s = out.to_string_lossy().into_owned();
        let mut replaced = false;
        for el in argv.iter_mut() {
            if el == MEDIA_OUT_TOKEN {
                *el = out_s.clone();
                replaced = true;
            }
        }
        if !replaced {
            return Err(DackError::Config(format!(
                "skill `{skill}/{command}` is `produces: media` but its argv has no {MEDIA_OUT_TOKEN} token"
            )));
        }
        Some(out_s)
    } else {
        None
    };

    Ok(SkillAuthz {
        tier: cmd.tier,
        trust: cmd.trust.clone(),
        // `env` is filled by the wall from the broker (the responder has it, `authorize` doesn't).
        exec: SkillExec { argv, secret: cmd.secret.clone(), env: BTreeMap::new(), network: cmd.network, produced_media },
    })
}

/// A safe cache FILENAME for a media-producing command's output: the **basename** of the (already
/// pattern-validated) media `ref`, restricted to `[0-9A-Za-z._-]`, length-capped, no leading/trailing dots
/// (no hidden files, no `..`). Basename + charset filter means no path traversal even if a manifest's `ref`
/// pattern were loose. Empty ⇒ a fixed fallback.
fn sanitize_media_name(raw: &str) -> String {
    let base = Path::new(raw).file_name().and_then(|s| s.to_str()).unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(96)
        .collect();
    let cleaned = cleaned.trim_matches('.');
    if cleaned.is_empty() { "media.bin".to_string() } else { cleaned.to_string() }
}

/// A skill's signed capability manifest. The `name` is part of the SIGNED bytes so a manifest can't be
/// lifted into another skill's dir and still verify for a different capability set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillManifest {
    /// Must match the skill's directory name (checked at load).
    pub name: String,
    pub commands: Vec<SkillCommand>,
}

/// One runnable command the pack exposes — a fixed argv template with typed holes, classified by tier +
/// taint exactly like an MCP capability.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SkillCommand {
    /// Stable id the model names in `RunSkillCommand { command }`.
    pub id: String,
    /// Capability tier — read (any state) · post (Express) · settle (Settle). Gated at the wall.
    pub tier: CapabilityTier,
    /// The taint label the command's data carries; running it FLOORS cycle trust to this.
    pub trust: TrustTier,
    /// The argv TEMPLATE. Element 0 is the program. `${SKILL_DIR}` resolves to the skill dir; `{hole}`
    /// tokens are replaced by validated args. Spawned via execve — never `sh -c`, so shell metacharacters
    /// in an arg value are inert bytes.
    pub argv: Vec<String>,
    /// Typed schema per `{hole}` in `argv`. Every hole MUST have an entry and every entry MUST be used as a
    /// hole (checked at load) — no undeclared holes, no dead schemas.
    #[serde(default)]
    pub args: BTreeMap<String, ArgSchema>,
    /// Secrets-provider `name` whose materialized value is injected into the spawned process env (like MCP
    /// `auth.secret`) — the credential reaches the executable, never the model context. Optional.
    #[serde(default)]
    pub secret: Option<String>,
    /// Whether the sandboxed process gets network egress (a relay/API command needs it; a local op doesn't).
    #[serde(default)]
    pub network: bool,
    /// What the command yields. `Some(Media)` ⇒ it writes an image to the `${MEDIA_OUT}` argv token (which the
    /// harness fixes to a media-dir path) and the bridge reads it back into a vision block. Absent ⇒ text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub produces: Option<Produces>,
}

/// The type of a typed hole. `String` matches an anchored regex (validated in the wall phase); `Enum` is a
/// fixed literal set (validated here — no dependency needed).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ArgSchema {
    String {
        /// Anchored (`^…$`) regex the value must fully match. Compiled + applied at the wall.
        pattern: String,
    },
    Enum {
        values: Vec<String>,
    },
    /// Filled by the HARNESS from the stimulus reply-SCOPE (a trusted routing scalar the ingress adapter put
    /// on the payload — e.g. `conversation`, `in_reply_to` — carried env-only across the firebreak), NOT the
    /// model. The model may NOT supply a `ref` arg (rejected if it tries). This is how a reply is
    /// destination-locked: the duck writes only the content; the harness routes it. Adapter-agnostic (buzz /
    /// slack / discord all populate the same scope scalars).
    Ref {
        from: String,
    },
}

impl SkillManifest {
    /// Parse + STRUCTURALLY validate a manifest (does NOT verify the signature — see [`load_signed`]). The
    /// structural checks are what make the later argv build total: unique ids, every argv hole is declared,
    /// every declared arg is used, and no `argv` is empty.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let m: SkillManifest = serde_yaml::from_slice(bytes)
            .map_err(|e| DackError::Config(format!("skill manifest parse: {e}")))?;
        m.validate_structure()?;
        Ok(m)
    }

    fn validate_structure(&self) -> Result<()> {
        if self.name.trim().is_empty() {
            return Err(DackError::Config("skill manifest: `name` is empty".into()));
        }
        let mut seen = std::collections::HashSet::new();
        for c in &self.commands {
            if c.id.trim().is_empty() {
                return Err(DackError::Config(format!("skill `{}`: a command has an empty id", self.name)));
            }
            if !seen.insert(&c.id) {
                return Err(DackError::Config(format!("skill `{}`: duplicate command id `{}`", self.name, c.id)));
            }
            if c.argv.is_empty() {
                return Err(DackError::Config(format!("skill `{}` cmd `{}`: `argv` is empty", self.name, c.id)));
            }
            let holes = holes_in_argv(&c.argv);
            for h in &holes {
                if !c.args.contains_key(h) {
                    return Err(DackError::Config(format!(
                        "skill `{}` cmd `{}`: argv hole `{{{h}}}` has no `args` schema",
                        self.name, c.id
                    )));
                }
            }
            for k in c.args.keys() {
                if !holes.contains(k) {
                    return Err(DackError::Config(format!(
                        "skill `{}` cmd `{}`: `args.{k}` is declared but never used in argv",
                        self.name, c.id
                    )));
                }
            }
            // `produces: media` ⟺ the argv carries the `${MEDIA_OUT}` token (the harness-fixed output path) and
            // a `ref` arg (the media id → cache filename). Keeps the two in lockstep so a media command can't
            // silently lose its output target, and a stray token can't appear on a text command.
            let has_media_token = c.argv.iter().any(|el| el.contains(MEDIA_OUT_TOKEN));
            match c.produces {
                Some(Produces::Media) => {
                    if !has_media_token {
                        return Err(DackError::Config(format!(
                            "skill `{}` cmd `{}`: `produces: media` requires the {MEDIA_OUT_TOKEN} argv token",
                            self.name, c.id
                        )));
                    }
                    if !c.args.contains_key("ref") {
                        return Err(DackError::Config(format!(
                            "skill `{}` cmd `{}`: `produces: media` requires a `ref` arg (the media id → cache filename)",
                            self.name, c.id
                        )));
                    }
                }
                None => {
                    if has_media_token {
                        return Err(DackError::Config(format!(
                            "skill `{}` cmd `{}`: uses {MEDIA_OUT_TOKEN} but is not `produces: media`",
                            self.name, c.id
                        )));
                    }
                }
            }
        }
        Ok(())
    }

    pub fn command(&self, id: &str) -> Option<&SkillCommand> {
        self.commands.iter().find(|c| c.id == id)
    }
}

impl ArgSchema {
    /// Validate a provided arg VALUE against its schema. `Enum` = exact membership; `String` = the value
    /// must FULLY match the (anchor-agnostic) regex. Args become separate argv elements (execve, not
    /// `sh -c`), so this is semantic validation — shell metacharacters are already inert bytes.
    pub fn validate(&self, name: &str, value: &str) -> Result<()> {
        match self {
            ArgSchema::Enum { values } => {
                if values.iter().any(|v| v == value) {
                    Ok(())
                } else {
                    Err(DackError::Config(format!("arg `{name}`: `{value}` not one of {values:?}")))
                }
            }
            ArgSchema::String { pattern } => {
                let re = regex::Regex::new(pattern)
                    .map_err(|e| DackError::Config(format!("arg `{name}`: bad pattern `{pattern}`: {e}")))?;
                // Require a match that spans the WHOLE value (robust regardless of the author's ^/$),
                // so a partial match can't smuggle extra content past a `{1,280}`-style bound.
                match re.find(value) {
                    Some(m) if m.start() == 0 && m.end() == value.len() => Ok(()),
                    _ => Err(DackError::Config(format!("arg `{name}`: `{value}` does not match /{pattern}/"))),
                }
            }
            // A `ref` arg is filled by the harness (build_argv), never validated against model input.
            ArgSchema::Ref { .. } => Ok(()),
        }
    }
}

impl SkillCommand {
    /// Validate the provided args against this command's schema and BUILD the concrete argv: every declared
    /// arg must be present (no missing, no extra), each value must validate, then `${SKILL_DIR}` → `skill_dir`
    /// and each `{hole}` → its validated value. The result is spawned via execve — never a shell — so the
    /// values are inert argv elements. `skill_dir` is the absolute (or guest) path substituted for the token.
    pub fn build_argv(&self, skill_dir: &str, model_args: &BTreeMap<String, String>, scope: &BTreeMap<String, String>) -> Result<Vec<String>> {
        // The model may supply only NON-ref declared args (a `ref` arg is harness-routed).
        for k in model_args.keys() {
            match self.args.get(k) {
                None => return Err(DackError::Config(format!("command `{}`: unexpected arg `{k}`", self.id))),
                Some(ArgSchema::Ref { .. }) => return Err(DackError::Config(format!("command `{}`: arg `{k}` is harness-routed and may not be supplied by the model", self.id))),
                _ => {}
            }
        }
        // Resolve every declared arg: `ref` from the trusted reply-scope, others from the (validated) model.
        let mut values: BTreeMap<String, String> = BTreeMap::new();
        for (name, schema) in &self.args {
            let value = match schema {
                ArgSchema::Ref { from } => scope
                    .get(from)
                    .cloned()
                    .ok_or_else(|| DackError::Config(format!("command `{}`: reply-scope has no `{from}` for arg `{name}`", self.id)))?,
                _ => {
                    let v = model_args.get(name).ok_or_else(|| DackError::Config(format!("command `{}`: missing arg `{name}`", self.id)))?;
                    schema.validate(name, v)?;
                    v.clone()
                }
            };
            values.insert(name.clone(), value);
        }
        // Substitute into every argv element. `${SKILL_DIR}` first, then each `{hole}`.
        let mut out = Vec::with_capacity(self.argv.len());
        for el in &self.argv {
            let mut s = el.replace(SKILL_DIR_TOKEN, skill_dir);
            for (name, value) in &values {
                s = s.replace(&format!("{{{name}}}"), value);
            }
            out.push(s);
        }
        Ok(out)
    }
}

/// Extract the `{hole}` tokens from an argv template (a `{name}` NOT preceded by `$` — so `${SKILL_DIR}` is
/// the special dir token, not a hole). Hole names are `[a-z0-9_]+`. Returns a de-duplicated set.
pub fn holes_in_argv(argv: &[String]) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    for el in argv {
        let bytes = el.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'{' && (i == 0 || bytes[i - 1] != b'$') {
                if let Some(rel) = el[i + 1..].find('}') {
                    let name = &el[i + 1..i + 1 + rel];
                    if !name.is_empty() && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_') {
                        out.insert(name.to_string());
                    }
                    i = i + 1 + rel + 1;
                    continue;
                }
            }
            i += 1;
        }
    }
    out
}

/// The path of a skill's detached signature file.
pub fn sig_path(skill_dir: &Path) -> PathBuf {
    skill_dir.join(format!("{MANIFEST_FILE}.sig"))
}
pub fn manifest_path(skill_dir: &Path) -> PathBuf {
    skill_dir.join(MANIFEST_FILE)
}

/// Load a skill manifest from `<skill_dir>/skill.manifest.yaml` ONLY IF its detached `.sig` verifies against
/// one of the `trusted` DIDs (operator + soul). This is the execute-gate: a missing/tampered/wrong-signer
/// signature is an `Err` — the caller treats the skill as prose-only (no execution). Also pins the manifest
/// `name` to the directory name, so a validly-signed manifest can't authorize a *different* dir's binaries.
pub fn load_signed(skill_dir: &Path, trusted: &[&Did]) -> Result<SkillManifest> {
    let mpath = manifest_path(skill_dir);
    let bytes = std::fs::read(&mpath)
        .map_err(|e| DackError::Config(format!("read {}: {e}", mpath.display())))?;
    let spath = sig_path(skill_dir);
    let sig_raw = std::fs::read(&spath).map_err(|e| {
        DackError::Config(format!("skill `{}` is UNSIGNED (no {}): {e} — prose-only, not executable", skill_dir.display(), spath.display()))
    })?;
    let sig = Signature(sig_raw);

    let signer = trusted.iter().find(|did| verify_ed25519_did(did, &bytes, &sig).unwrap_or(false));
    if signer.is_none() {
        return Err(DackError::Identity(format!(
            "skill `{}`: manifest signature verifies against NEITHER operator nor soul — refusing to execute",
            skill_dir.display()
        )));
    }

    let manifest = SkillManifest::parse(&bytes)?;
    if let Some(dirname) = skill_dir.file_name().and_then(|s| s.to_str()) {
        if manifest.name != dirname {
            return Err(DackError::Config(format!(
                "skill dir `{dirname}` holds a manifest named `{}` — name must match the dir (signed-name pinning)",
                manifest.name
            )));
        }
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::ed25519::{ed25519_pub_to_did, encode_signature};
    use ed25519_dalek::{Signer, SigningKey};

    const MANIFEST: &str = r#"
name: buzz
commands:
  - id: feed
    tier: read
    trust: public
    argv: ["${SKILL_DIR}/bin/buzz", "feed", "read", "--limit", "{limit}"]
    args:
      limit: { type: enum, values: ["10", "25", "50"] }
  - id: post
    tier: post
    trust: self
    argv: ["${SKILL_DIR}/bin/buzz", "social", "publish", "note", "{text}"]
    args:
      text: { type: string, pattern: "^.{1,280}$" }
    secret: buzz_key
    network: true
"#;

    #[test]
    fn parses_a_well_formed_manifest() {
        let m = SkillManifest::parse(MANIFEST.as_bytes()).expect("parse");
        assert_eq!(m.name, "buzz");
        assert_eq!(m.commands.len(), 2);
        let feed = m.command("feed").unwrap();
        assert_eq!(feed.tier, CapabilityTier::Read);
        assert_eq!(feed.argv[0], "${SKILL_DIR}/bin/buzz");
        let post = m.command("post").unwrap();
        assert_eq!(post.tier, CapabilityTier::Post);
        assert_eq!(post.secret.as_deref(), Some("buzz_key"));
        assert!(post.network);
    }

    #[test]
    fn holes_extraction_ignores_the_skill_dir_token() {
        let argv: Vec<String> = ["${SKILL_DIR}/bin/x", "{a}", "--flag", "{b_2}"].iter().map(|s| s.to_string()).collect();
        let holes = holes_in_argv(&argv);
        assert!(holes.contains("a") && holes.contains("b_2"));
        assert!(!holes.contains("SKILL_DIR")); // $-prefixed → not a hole
        assert_eq!(holes.len(), 2);
    }

    #[test]
    fn rejects_an_undeclared_argv_hole() {
        let bad = "name: x\ncommands:\n  - id: c\n    tier: read\n    trust: self\n    argv: [\"p\", \"{missing}\"]\n";
        let err = SkillManifest::parse(bad.as_bytes()).unwrap_err().to_string();
        assert!(err.contains("no `args` schema"), "{err}");
    }

    #[test]
    fn rejects_a_dead_arg_schema() {
        let bad = "name: x\ncommands:\n  - id: c\n    tier: read\n    trust: self\n    argv: [\"p\"]\n    args:\n      unused: { type: enum, values: [\"a\"] }\n";
        let err = SkillManifest::parse(bad.as_bytes()).unwrap_err().to_string();
        assert!(err.contains("never used in argv"), "{err}");
    }

    #[test]
    fn build_argv_validates_and_substitutes() {
        let m = SkillManifest::parse(MANIFEST.as_bytes()).unwrap();
        let feed = m.command("feed").unwrap();
        let mut args = BTreeMap::new();
        args.insert("limit".to_string(), "25".to_string());
        let argv = feed.build_argv("/soul/skills/buzz", &args, &BTreeMap::new()).unwrap();
        assert_eq!(argv, vec!["/soul/skills/buzz/bin/buzz", "feed", "read", "--limit", "25"]);

        // Enum rejects an off-list value.
        let mut bad = BTreeMap::new();
        bad.insert("limit".to_string(), "999".to_string());
        assert!(feed.build_argv("/x", &bad, &BTreeMap::new()).unwrap_err().to_string().contains("not one of"));

        // Missing / extra args are rejected.
        assert!(feed.build_argv("/x", &BTreeMap::new(), &BTreeMap::new()).unwrap_err().to_string().contains("missing arg"));
        let mut extra = args.clone();
        extra.insert("bogus".to_string(), "1".to_string());
        assert!(feed.build_argv("/x", &extra, &BTreeMap::new()).unwrap_err().to_string().contains("unexpected arg"));
    }

    #[test]
    fn build_argv_string_pattern_full_match_and_injection_is_inert() {
        let m = SkillManifest::parse(MANIFEST.as_bytes()).unwrap();
        let post = m.command("post").unwrap();
        // A normal note validates + lands as ONE argv element (execve, not shell → metachars inert).
        let mut args = BTreeMap::new();
        args.insert("text".to_string(), "gm; rm -rf / $(whoami) `id`".to_string());
        let argv = post.build_argv("/s", &args, &BTreeMap::new()).unwrap();
        assert_eq!(argv.last().unwrap(), "gm; rm -rf / $(whoami) `id`"); // inert — one element, no shell
        assert_eq!(argv[0], "/s/bin/buzz");

        // A 281-char note fails the `^.{1,280}$` bound (partial match can't sneak past — whole-span check).
        let mut too_long = BTreeMap::new();
        too_long.insert("text".to_string(), "x".repeat(281));
        assert!(post.build_argv("/s", &too_long, &BTreeMap::new()).unwrap_err().to_string().contains("does not match"));

        // A newline-bearing value can't satisfy `^.{1,280}$` (`.` excludes \n) — no multiline smuggling.
        let mut nl = BTreeMap::new();
        nl.insert("text".to_string(), "line1\nline2".to_string());
        assert!(post.build_argv("/s", &nl, &BTreeMap::new()).is_err());
    }

    #[test]
    fn ref_args_are_filled_from_scope_and_the_model_cannot_supply_them() {
        let manifest = r#"
name: buzz
commands:
  - id: reply
    tier: post
    trust: self
    argv: ["p", "--channel", "{channel}", "--content", "{text}", "--reply-to", "{in_reply_to}"]
    args:
      channel: { type: ref, from: conversation }
      in_reply_to: { type: ref, from: in_reply_to }
      text: { type: string, pattern: "^.{1,100}$" }
"#;
        let cmd = SkillManifest::parse(manifest.as_bytes()).unwrap().command("reply").unwrap().clone();
        let mut scope = BTreeMap::new();
        scope.insert("conversation".into(), "chan-1".to_string());
        scope.insert("in_reply_to".into(), "evt-9".to_string());
        let mut model = BTreeMap::new();
        model.insert("text".into(), "hi there".to_string());
        // ref args filled from scope; model supplies only `text`.
        assert_eq!(
            cmd.build_argv("/s", &model, &scope).unwrap(),
            vec!["p", "--channel", "chan-1", "--content", "hi there", "--reply-to", "evt-9"]
        );
        // The model may NOT set a ref arg (destination-lock — no hijacking the reply target).
        let mut hijack = model.clone();
        hijack.insert("channel".into(), "attacker-channel".to_string());
        assert!(cmd.build_argv("/s", &hijack, &scope).unwrap_err().to_string().contains("harness-routed"));
        // No scope ⇒ deny (fail-closed).
        assert!(cmd.build_argv("/s", &model, &BTreeMap::new()).unwrap_err().to_string().contains("reply-scope has no"));
    }

    #[test]
    fn media_command_parse_validates_token_and_ref() {
        let ok = r#"
name: buzz
commands:
  - id: media_get
    tier: read
    trust: public
    argv: ["${SKILL_DIR}/bin/buzz", "media", "get", "{ref}", "-o", "${MEDIA_OUT}"]
    args:
      ref: { type: string, pattern: "^[0-9a-f]{64}\\.(png|jpg)$" }
    produces: media
"#;
        assert_eq!(SkillManifest::parse(ok.as_bytes()).unwrap().command("media_get").unwrap().produces, Some(Produces::Media));

        // produces: media but the argv lacks ${MEDIA_OUT} → reject.
        let no_tok = ok.replace(", \"-o\", \"${MEDIA_OUT}\"", "");
        assert!(SkillManifest::parse(no_tok.as_bytes()).unwrap_err().to_string().contains("MEDIA_OUT"));

        // ${MEDIA_OUT} present but not `produces: media` → reject (no stray output sink).
        let stray = ok.replace("    produces: media\n", "");
        assert!(SkillManifest::parse(stray.as_bytes()).unwrap_err().to_string().contains("not `produces: media`"));

        // produces: media without a `ref` arg → reject (need the cache-name source).
        let no_ref = "name: buzz\ncommands:\n  - id: g\n    tier: read\n    trust: public\n    argv: [\"p\", \"{limit}\", \"-o\", \"${MEDIA_OUT}\"]\n    args:\n      limit: { type: enum, values: [\"1\"] }\n    produces: media\n";
        assert!(SkillManifest::parse(no_ref.as_bytes()).unwrap_err().to_string().contains("requires a `ref` arg"));
    }

    #[test]
    fn sanitize_media_name_is_basename_only_and_charset_filtered() {
        assert_eq!(sanitize_media_name("3bda987db27d46c34c4f13884bbc579e4f982646056b5524d5726425d8a97d73.png"), "3bda987db27d46c34c4f13884bbc579e4f982646056b5524d5726425d8a97d73.png");
        assert_eq!(sanitize_media_name("../../etc/passwd"), "passwd"); // basename drops the traversal
        assert_eq!(sanitize_media_name("../.."), "media.bin"); // trims to nothing → fallback
        assert_eq!(sanitize_media_name(""), "media.bin");
        assert!(!sanitize_media_name("a/b/c;rm -rf.png").contains(';')); // charset-filtered
    }

    #[test]
    fn authorize_media_command_fixes_output_path_and_records_it() {
        let op = SigningKey::from_bytes(&[3u8; 32]);
        let op_did = ed25519_pub_to_did(op.verifying_key().to_bytes());
        let trusted: Vec<&Did> = vec![&op_did];
        let base = std::env::temp_dir().join(format!("dack-skillmedia-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let d = base.join("buzz");
        let manifest = r#"
name: buzz
commands:
  - id: media_get
    tier: read
    trust: public
    argv: ["${SKILL_DIR}/bin/buzz", "media", "get", "{ref}", "-o", "${MEDIA_OUT}"]
    args:
      ref: { type: string, pattern: "^[0-9a-f]{64}(\\.thumb)?\\.(png|jpe?g|gif|webp)$" }
    produces: media
    secret: buzz_key
    network: true
"#;
        write_skill(&d, manifest, Some(&op));
        let media = base.join("media");
        let sha = "3bda987db27d46c34c4f13884bbc579e4f982646056b5524d5726425d8a97d73.png";
        let mut args = BTreeMap::new();
        args.insert("ref".to_string(), sha.to_string());

        let authz = authorize(&base, "buzz", "media_get", &args, &trusted, &BTreeMap::new(), Some(media.as_path())).unwrap();
        let out = media.join(sha).to_string_lossy().into_owned();
        // ${MEDIA_OUT} resolved to <media>/<sha>, recorded for the bridge; the token is gone; model never named it.
        assert!(authz.exec.argv.contains(&out), "argv carries the fixed -o path: {:?}", authz.exec.argv);
        assert_eq!(authz.exec.produced_media.as_deref(), Some(out.as_str()));
        assert!(!authz.exec.argv.iter().any(|a| a.contains(MEDIA_OUT_TOKEN)));

        // No media dir ⇒ deny (fail-closed).
        assert!(authorize(&base, "buzz", "media_get", &args, &trusted, &BTreeMap::new(), None).unwrap_err().to_string().contains("no media dir"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_duplicate_command_ids() {
        let bad = "name: x\ncommands:\n  - id: c\n    tier: read\n    trust: self\n    argv: [\"p\"]\n  - id: c\n    tier: read\n    trust: self\n    argv: [\"q\"]\n";
        assert!(SkillManifest::parse(bad.as_bytes()).unwrap_err().to_string().contains("duplicate command id"));
    }

    // ── the execute-gate: signature verification ──────────────────────────────────────────────────

    fn write_skill(dir: &Path, manifest: &str, sign_with: Option<&SigningKey>) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(manifest_path(dir), manifest).unwrap();
        if let Some(sk) = sign_with {
            let sig = encode_signature(sk.sign(manifest.as_bytes()).to_bytes());
            std::fs::write(sig_path(dir), sig).unwrap();
        }
    }

    #[test]
    fn load_signed_accepts_the_operator_signature_and_rejects_others() {
        let op = SigningKey::from_bytes(&[1u8; 32]);
        let soul = SigningKey::from_bytes(&[2u8; 32]);
        let stranger = SigningKey::from_bytes(&[9u8; 32]);
        let op_did = ed25519_pub_to_did(op.verifying_key().to_bytes());
        let soul_did = ed25519_pub_to_did(soul.verifying_key().to_bytes());
        let trusted: Vec<&Did> = vec![&op_did, &soul_did];

        let base = std::env::temp_dir().join(format!("dack-skilltest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);

        // (a) operator-signed → loads.
        let d = base.join("buzz");
        write_skill(&d, MANIFEST, Some(&op));
        assert!(load_signed(&d, &trusted).is_ok());

        // (b) soul-signed → also loads (operator OR agent).
        let _ = std::fs::remove_dir_all(&d);
        write_skill(&d, MANIFEST, Some(&soul));
        assert!(load_signed(&d, &trusted).is_ok());

        // (c) stranger-signed → rejected.
        let _ = std::fs::remove_dir_all(&d);
        write_skill(&d, MANIFEST, Some(&stranger));
        assert!(load_signed(&d, &trusted).unwrap_err().to_string().contains("NEITHER"));

        // (d) tampered manifest (signature no longer matches the bytes) → rejected.
        let _ = std::fs::remove_dir_all(&d);
        write_skill(&d, MANIFEST, Some(&op));
        std::fs::write(manifest_path(&d), MANIFEST.replace("read", "settle")).unwrap(); // change bytes post-sign
        assert!(load_signed(&d, &trusted).is_err());

        // (e) unsigned → rejected as prose-only.
        let _ = std::fs::remove_dir_all(&d);
        write_skill(&d, MANIFEST, None);
        assert!(load_signed(&d, &trusted).unwrap_err().to_string().contains("UNSIGNED"));

        // (f) name/dir mismatch → rejected even if validly signed.
        let _ = std::fs::remove_dir_all(&base);
        let wrong = base.join("not-buzz");
        write_skill(&wrong, MANIFEST, Some(&op));
        assert!(load_signed(&wrong, &trusted).unwrap_err().to_string().contains("name must match"));

        let _ = std::fs::remove_dir_all(&base);
    }
}
