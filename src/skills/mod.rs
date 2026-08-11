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
        }
        Ok(())
    }

    pub fn command(&self, id: &str) -> Option<&SkillCommand> {
        self.commands.iter().find(|c| c.id == id)
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
