//! Harness-owned media store (Phase 1: Telegram photos / screenshots).
//!
//! Untrusted image bytes from a channel adapter (the telegram-ingress module downloads a photo and
//! writes it here) live in a directory the HARNESS owns — not the soul, not a bridge scratch. The
//! stimulus payload carries only a *filename*; the harness [`resolve`]s it into a confined absolute
//! path + MIME, which the bridge later reads and base64s into an image content-block.
//!
//! Two invariants make this safe:
//!   1. **Confinement.** The ingress-supplied name is reduced to its basename and re-joined under the
//!      media dir, then canonicalized and checked to still live inside it — so a crafted
//!      `../../etc/passwd` in the payload can never make the bridge read outside the media dir.
//!   2. **Untrusted lane only.** Media rides the Perceive `world-payload` (fenced untrusted) and is
//!      reachable later only via the raw-recall path. The soul workdir does not include the media dir,
//!      so the agent's own `Read` tool cannot reach it — images are never on the trusted lane.
//!
//! Retention is predictable: [`gc`] deletes files older than `media_retention_days` (boot + the
//! periodic runlog GC tick), bounding disk like the runlog does.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::runtime::{MediaKind, MediaRef};

/// Max images surfaced from a single stimulus — a cheap DoS/token guard (a burst of photos in one
/// message can't balloon the turn). Extra images beyond this are dropped.
const MAX_MEDIA_PER_STIMULUS: usize = 6;

/// Resolve the configured (cwd-relative) media dir to an absolute path.
pub fn dir(configured: &str) -> PathBuf {
    let p = Path::new(configured);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(p)
    }
}

/// Ensure the media dir exists (created on boot; ignored if already there).
pub fn ensure_dir(media_dir: &Path) {
    let _ = std::fs::create_dir_all(media_dir);
}

/// Extract + CONFINE the media attachments named in a stimulus payload. Reads `payload.media`, an
/// array of `{ kind: "image", file: "<name>", mime: "image/..." }` written by the ingress. Each entry
/// is confined to `media_dir` (basename-only + canonical-prefix check) and must be an existing regular
/// file; anything else (traversal, missing, non-image) is silently skipped. Returns at most
/// [`MAX_MEDIA_PER_STIMULUS`] refs. Empty (the common case) for any payload without images.
pub fn resolve(payload: &Value, media_dir: &Path) -> Vec<MediaRef> {
    let Some(arr) = payload.get("media").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let root = match media_dir.canonicalize() {
        Ok(r) => r,
        Err(_) => return Vec::new(), // no media dir yet ⇒ nothing to resolve
    };
    let mut out = Vec::new();
    for m in arr {
        if out.len() >= MAX_MEDIA_PER_STIMULUS {
            break;
        }
        // Phase 1: images only. A non-image kind (future audio, etc.) is ignored here.
        if m.get("kind").and_then(|v| v.as_str()).unwrap_or("image") != "image" {
            continue;
        }
        let Some(file) = m.get("file").and_then(|v| v.as_str()) else {
            continue;
        };
        // CONFINE: basename only (drops any dir components / `..`), re-joined under the media dir.
        let Some(name) = Path::new(file).file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let path = media_dir.join(name);
        // Belt-and-suspenders: canonicalize + verify it still lives under the (canonical) media dir and
        // is a regular file. Rejects symlink escapes and missing files.
        let Ok(canon) = path.canonicalize() else {
            continue;
        };
        if !canon.starts_with(&root) || !canon.is_file() {
            continue;
        }
        let mime = m
            .get("mime")
            .and_then(|v| v.as_str())
            .filter(|s| s.starts_with("image/"))
            .unwrap_or("image/jpeg")
            .to_string();
        out.push(MediaRef { kind: MediaKind::Image, path: canon.to_string_lossy().into_owned(), mime });
    }
    out
}

/// Delete media files older than `retention_days` (by mtime). `0` ⇒ keep forever. Returns the count
/// removed. Best-effort: an unreadable dir/entry is skipped, never fatal.
pub fn gc(media_dir: &Path, retention_days: u64, now_secs: i64) -> usize {
    if retention_days == 0 {
        return 0;
    }
    let cutoff = now_secs - (retention_days as i64) * 86_400;
    let Ok(rd) = std::fs::read_dir(media_dir) else {
        return 0;
    };
    let mut n = 0;
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_file() {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
        if let Some(age) = modified {
            if (age.as_secs() as i64) < cutoff && std::fs::remove_file(&p).is_ok() {
                n += 1;
            }
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(dir: &Path, name: &str, bytes: &[u8]) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(name), bytes).unwrap();
    }

    #[test]
    fn resolves_confines_and_skips_traversal() {
        let tmp = std::env::temp_dir().join(format!("dack-media-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        write(&tmp, "shot.jpg", b"\xff\xd8\xff"); // a "real" stored image

        let payload = json!({
            "text": "look",
            "media": [
                { "kind": "image", "file": "shot.jpg", "mime": "image/jpeg" }, // ok
                { "kind": "image", "file": "../../../etc/passwd", "mime": "image/jpeg" }, // traversal → basename `passwd`, no such file → skipped
                { "kind": "image", "file": "missing.png", "mime": "image/png" }, // not on disk → skipped
                { "kind": "audio", "file": "shot.jpg" }, // non-image kind → skipped
            ]
        });
        let out = resolve(&payload, &tmp);
        assert_eq!(out.len(), 1, "only the existing confined image survives");
        assert!(out[0].path.ends_with("shot.jpg"));
        assert!(std::path::Path::new(&out[0].path).is_absolute());
        assert_eq!(out[0].mime, "image/jpeg");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn no_media_field_is_empty() {
        let tmp = std::env::temp_dir().join(format!("dack-media-empty-{}", std::process::id()));
        ensure_dir(&tmp);
        assert!(resolve(&json!({ "text": "hi" }), &tmp).is_empty());
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn gc_deletes_only_old_files() {
        let tmp = std::env::temp_dir().join(format!("dack-media-gc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        write(&tmp, "keep.jpg", b"x");
        // now = far future so the just-written file is "old" relative to a 0-day-from-that cutoff:
        // use retention 7d and a now 100 days ahead → the file (mtime ~ real now) is older than cutoff.
        let now_far = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
            + 100 * 86_400;
        assert_eq!(gc(&tmp, 7, now_far), 1, "the file is older than a 7-day cutoff taken 100d ahead");
        assert!(!tmp.join("keep.jpg").exists());
        // retention 0 = keep forever
        write(&tmp, "keep2.jpg", b"y");
        assert_eq!(gc(&tmp, 0, now_far), 0);
        assert!(tmp.join("keep2.jpg").exists());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
