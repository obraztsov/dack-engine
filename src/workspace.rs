//! The agent **WORKSPACE** — one harness-owned scratch directory per duck, BESIDE the soul (never inside
//! the git tree). Documents land in `inbox/`, the duck authors files anywhere under it, Buzz repos are
//! cloned under `repos/`. The WALL governs it (read-only in Perceive, writable in Express/Settle/Reflect,
//! `workspace.write_min_trust` to write, `workspace.read_trust_cap` applied after any touch); this module
//! only resolves, creates and sweeps the directory. Design: docs/design/workspace-and-documents.md.

use std::path::{Path, PathBuf};

pub const INBOX: &str = "inbox";
pub const OUTBOX: &str = "outbox";
pub const REPOS: &str = "repos";

/// Resolve the configured dir: absolute as-is, else relative to the harness cwd (like `media::dir`).
pub fn dir(configured: &str) -> PathBuf {
    let p = Path::new(configured);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(p)
    }
}

/// Create the workspace and its conventional subdirs (idempotent, best-effort).
pub fn ensure_dirs(root: &Path) {
    for sub in [INBOX, OUTBOX, REPOS] {
        if let Err(e) = std::fs::create_dir_all(root.join(sub)) {
            tracing::warn!("workspace: cannot create {}: {e}", root.join(sub).display());
        }
    }
}

/// Sweep `inbox/` files older than `retention_days` (mtime). `0` ⇒ keep everything. Only the inbox:
/// what the duck authored or cloned is its own to remove. Returns the number of files removed.
pub fn gc_inbox(root: &Path, retention_days: u64, now: i64) -> usize {
    if retention_days == 0 {
        return 0;
    }
    let cutoff = now - (retention_days as i64) * 86_400;
    let mut removed = 0;
    let mut stack = vec![root.join(INBOX)];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(now);
            if mtime < cutoff && std::fs::remove_file(&p).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbox_gc_removes_only_old_inbox_files() {
        let root = std::env::temp_dir().join(format!("dack-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        ensure_dirs(&root);
        assert!(root.join(REPOS).is_dir() && root.join(OUTBOX).is_dir());
        std::fs::write(root.join(INBOX).join("old.md"), "x").unwrap();
        std::fs::write(root.join(OUTBOX).join("mine.md"), "y").unwrap(); // never swept
        let now = 2_000_000_000; // far future ⇒ both files are "old"
        assert_eq!(gc_inbox(&root, 0, now), 0, "0 = keep");
        assert_eq!(gc_inbox(&root, 30, now), 1);
        assert!(!root.join(INBOX).join("old.md").exists());
        assert!(root.join(OUTBOX).join("mine.md").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
