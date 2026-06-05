//! Gitlawb identity adapter (PRD §3.1, §3.4) — v1 implementation of [`IdentityProvider`],
//! grounded against `gl` 0.3.8 (`docs/VERIFICATION.md`).
//!
//! Each role is a separate `gl` identity **dir** (`gl identity new --dir <dir>` writes an
//! `identity.pem`; the DID is `did:key:z6Mk…`). The **Soul dir is harness-only** — its key
//! never enters agent env; the harness invokes `gl identity sign --dir <soul>` to attest
//! commits on the duck's behalf (PRD §3.3). The Builder dir is env-forwardable.
//!
//! - `sign`  → `gl identity sign --dir <dir> <message>` → base64url Ed25519 signature.
//! - `did`   → resolved at construction via `gl identity show --dir <dir>`.
//! - `verify`→ deferred to Phase 8 (`dack say` operator_signed): decode `did:key` → Ed25519
//!   pubkey and verify in-process. `gl` 0.3.8 exposes no general message-verify command, so
//!   verification is ours to do (provenance is a local crypto check — PRD §5.7).

use std::collections::HashMap;
use std::path::PathBuf;

use async_trait::async_trait;
use tokio::process::Command;

use super::{Did, IdentityProvider, IdentityRole, Signature};
use crate::error::{DackError, Result};

pub struct GitlawbIdentity {
    gl_bin: String,
    dirs: HashMap<IdentityRole, PathBuf>,
    dids: HashMap<IdentityRole, Did>,
}

impl GitlawbIdentity {
    /// Resolve the DID for each configured role dir up front (one `gl identity show` each),
    /// so `did()` can stay synchronous. Roles without a dir are simply absent.
    pub async fn resolve(
        gl_bin: impl Into<String>,
        dirs: HashMap<IdentityRole, PathBuf>,
    ) -> Result<Self> {
        let gl_bin = gl_bin.into();
        let mut dids = HashMap::new();
        for (role, dir) in &dirs {
            let did = gl_show(&gl_bin, dir).await?;
            dids.insert(*role, did);
        }
        Ok(Self { gl_bin, dirs, dids })
    }

    fn dir(&self, role: IdentityRole) -> Result<&PathBuf> {
        self.dirs
            .get(&role)
            .ok_or_else(|| DackError::Identity(format!("no identity dir for {role:?}")))
    }
}

async fn gl_show(gl_bin: &str, dir: &PathBuf) -> Result<Did> {
    let out = Command::new(gl_bin)
        .args(["identity", "show", "--dir"])
        .arg(dir)
        .output()
        .await
        .map_err(|e| DackError::Identity(format!("gl spawn: {e}")))?;
    if !out.status.success() {
        return Err(DackError::Identity(format!(
            "gl identity show: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(Did(String::from_utf8_lossy(&out.stdout).trim().to_string()))
}

#[async_trait]
impl IdentityProvider for GitlawbIdentity {
    fn did(&self, role: IdentityRole) -> Option<&Did> {
        self.dids.get(&role)
    }

    async fn sign(&self, role: IdentityRole, payload: &[u8]) -> Result<Signature> {
        let dir = self.dir(role)?;
        // v1: messages are UTF-8 (commit attestations, `dack say` text). Binary payloads
        // would be base64url-wrapped before signing; not needed in v1.
        let message = std::str::from_utf8(payload)
            .map_err(|_| DackError::Identity("sign payload not UTF-8 (v1 limitation)".into()))?;
        let out = Command::new(&self.gl_bin)
            .args(["identity", "sign", "--dir"])
            .arg(dir)
            .arg(message)
            .output()
            .await
            .map_err(|e| DackError::Identity(format!("gl spawn: {e}")))?;
        if !out.status.success() {
            return Err(DackError::Identity(format!(
                "gl identity sign: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        // stdout = base64url signature. We store its ASCII bytes; Phase-8 verify decodes it.
        Ok(Signature(String::from_utf8_lossy(&out.stdout).trim().as_bytes().to_vec()))
    }

    async fn verify(&self, _did: &Did, _payload: &[u8], _sig: &Signature) -> Result<bool> {
        // Phase 8 (operator_signed / `dack say`): decode `did:key:z6Mk…` → 32-byte Ed25519
        // public key (multibase base58btc + 0xed01 multicodec) and verify in-process. No
        // `gl` verify command exists, and provenance must be a local crypto check anyway.
        Err(DackError::NotImplemented(
            "GitlawbIdentity::verify — Phase 8 (did:key decode + ed25519 verify)",
        ))
    }
}
