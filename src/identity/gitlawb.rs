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

    async fn verify(&self, did: &Did, payload: &[u8], sig: &Signature) -> Result<bool> {
        // Phase 8 (operator_signed / `dack say`): a LOCAL crypto check, never a rhetorical one.
        // Pure (no `self` state) → factored out so the unit test can exercise it without `gl`.
        verify_ed25519_did(did, payload, sig)
    }
}

/// Verify an Ed25519 signature over `payload` against the key encoded in a `did:key`. The
/// signature is the ASCII of the base64 string `gl identity sign` emits (we decode liberally:
/// url-safe/standard, padded/unpadded). Returns `Ok(false)` for a well-formed-but-wrong
/// signature; `Err` only when the DID or signature is structurally undecodable.
pub fn verify_ed25519_did(did: &Did, payload: &[u8], sig: &Signature) -> Result<bool> {
    use ed25519_dalek::{Signature as Ed25519Sig, Verifier, VerifyingKey};

    let pubkey = did_key_to_ed25519(&did.0)?;
    let verifying = VerifyingKey::from_bytes(&pubkey)
        .map_err(|e| DackError::Identity(format!("did pubkey not a valid ed25519 point: {e}")))?;
    let sig_bytes = decode_signature_64(&sig.0)?;
    let signature = Ed25519Sig::from_bytes(&sig_bytes);
    Ok(verifying.verify(payload, &signature).is_ok())
}

/// `did:key:z6Mk…` → the 32-byte Ed25519 public key. The body after `z` is multibase
/// base58btc of `0xed 0x01` (the ed25519-pub multicodec) followed by the raw 32-byte key.
fn did_key_to_ed25519(did: &str) -> Result<[u8; 32]> {
    let body = did
        .strip_prefix("did:key:")
        .ok_or_else(|| DackError::Identity(format!("not a did:key: `{did}`")))?;
    let b58 = body
        .strip_prefix('z')
        .ok_or_else(|| DackError::Identity(format!("did:key not base58btc (`z…`): `{did}`")))?;
    let bytes = bs58::decode(b58)
        .into_vec()
        .map_err(|e| DackError::Identity(format!("did:key base58 decode: {e}")))?;
    // 2-byte multicodec prefix (0xed 0x01 = ed25519-pub) + 32-byte key.
    if bytes.len() != 34 || bytes[0] != 0xed || bytes[1] != 0x01 {
        return Err(DackError::Identity(format!(
            "did:key not an ed25519-pub multicodec (len {}, prefix {:02x?})",
            bytes.len(),
            &bytes[..bytes.len().min(2)]
        )));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes[2..34]);
    Ok(key)
}

/// Decode the stored signature (ASCII of a base64 string) into the 64 raw Ed25519 bytes,
/// trying the common base64 alphabets/padding so we don't couple to `gl`'s exact choice.
fn decode_signature_64(raw: &[u8]) -> Result<[u8; 64]> {
    use base64::Engine;
    let s = std::str::from_utf8(raw)
        .map_err(|_| DackError::Identity("signature not UTF-8 base64".into()))?
        .trim();
    let engines: [&base64::engine::GeneralPurpose; 4] = [
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        &base64::engine::general_purpose::URL_SAFE,
        &base64::engine::general_purpose::STANDARD_NO_PAD,
        &base64::engine::general_purpose::STANDARD,
    ];
    for engine in engines {
        if let Ok(bytes) = engine.decode(s) {
            if bytes.len() == 64 {
                let mut sig = [0u8; 64];
                sig.copy_from_slice(&bytes);
                return Ok(sig);
            }
        }
    }
    Err(DackError::Identity(format!(
        "signature did not base64-decode to 64 bytes (`{}…`)",
        &s[..s.len().min(12)]
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    use ed25519_dalek::{Signer, SigningKey};

    /// Build a `did:key` + a base64url signature the way `gl identity sign` would, but in-process
    /// from a fixed key — so the verify path is tested without depending on the `gl` binary.
    fn did_and_sig(secret: [u8; 32], message: &[u8]) -> (Did, Signature) {
        let sk = SigningKey::from_bytes(&secret);
        let pubkey = sk.verifying_key().to_bytes();
        let mut multicodec = vec![0xed, 0x01];
        multicodec.extend_from_slice(&pubkey);
        let did = Did(format!("did:key:z{}", bs58::encode(multicodec).into_string()));
        let sig = sk.sign(message);
        let sig_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes());
        (did, Signature(sig_b64.into_bytes()))
    }

    #[test]
    fn verify_accepts_a_genuine_signature() {
        let msg = b"buy nothing today, duck";
        let (did, sig) = did_and_sig([7u8; 32], msg);
        assert!(verify_ed25519_did(&did, msg, &sig).unwrap());
    }

    #[test]
    fn verify_rejects_a_tampered_payload() {
        let (did, sig) = did_and_sig([7u8; 32], b"the real instruction");
        // Same did + sig, different payload → the IFC downgrade path (operator_signed → public).
        assert!(!verify_ed25519_did(&did, b"a forged instruction", &sig).unwrap());
    }

    #[test]
    fn verify_rejects_a_wrong_signer() {
        let msg = b"signed by someone else";
        let (_their_did, their_sig) = did_and_sig([9u8; 32], msg);
        let (operator_did, _) = did_and_sig([7u8; 32], msg);
        // A valid signature, but not by the claimed (operator) DID.
        assert!(!verify_ed25519_did(&operator_did, msg, &their_sig).unwrap());
    }

    #[test]
    fn verify_errors_on_a_malformed_did() {
        let (_, sig) = did_and_sig([7u8; 32], b"x");
        assert!(verify_ed25519_did(&Did("did:web:example.com".into()), b"x", &sig).is_err());
    }
}
