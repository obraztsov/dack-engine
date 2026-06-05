//! Shared git operations behind the [`RepoHost`](super::RepoHost) seam.
//!
//! Grounded against `gl` 0.3.8: Gitlawb has **no `repo commit`/`push`** — commits and
//! pushes go through plain `git`, and the `git-remote-gitlawb` helper signs the ref-update
//! on a `gitlawb://` remote. So `GitlawbRepo` and `PlainGitRepo` share *this* core and
//! differ only in the remote URL + push-signing identity (PRD §3.5 made literal: the
//! bundle is just a git repo).
//!
//! The duck "authors its own commits" via per-commit `git -c user.name=<DID>` — the commit
//! history is attributed to the Soul DID (on-thesis), while the *signing key* stays in the
//! `gl` identity dir the harness controls (never in agent env).

use std::path::PathBuf;

use tokio::process::Command;

use super::{CommitId, CommitMeta, RepoPath};
use crate::error::{DackError, Result};

pub struct GitCore {
    pub workdir: PathBuf,
    /// DID used to attribute harness-authored commits (e.g. reverts) when no per-commit
    /// author is supplied.
    pub default_author: String,
}

impl GitCore {
    pub fn new(workdir: impl Into<PathBuf>, default_author: impl Into<String>) -> Self {
        Self {
            workdir: workdir.into(),
            default_author: default_author.into(),
        }
    }

    /// Run `git -C <workdir> <args>` and return stdout, or an error carrying stderr.
    async fn git(&self, args: &[&str]) -> Result<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.workdir)
            .args(args)
            .output()
            .await
            .map_err(|e| DackError::Repo(format!("git spawn ({}): {e}", args.join(" "))))?;
        if !out.status.success() {
            return Err(DackError::Repo(format!(
                "git {}: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    async fn head(&self) -> Result<CommitId> {
        Ok(CommitId(self.git(&["rev-parse", "HEAD"]).await?.trim().to_string()))
    }

    pub async fn read_file(&self, path: &RepoPath) -> Result<Vec<u8>> {
        let full = self.workdir.join(&path.0);
        tokio::fs::read(&full)
            .await
            .map_err(|e| DackError::Repo(format!("read {}: {e}", path.0)))
    }

    /// Write + commit a single file, attributed to `commit.author_did`. Idempotent: if the
    /// contents are unchanged, no empty commit is made and the current HEAD is returned.
    pub async fn write_file(
        &self,
        path: &RepoPath,
        contents: &[u8],
        commit: &CommitMeta,
    ) -> Result<CommitId> {
        let full = self.workdir.join(&path.0);
        if let Some(parent) = full.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| DackError::Repo(format!("mkdir {}: {e}", path.0)))?;
        }
        tokio::fs::write(&full, contents)
            .await
            .map_err(|e| DackError::Repo(format!("write {}: {e}", path.0)))?;
        self.git(&["add", "--", &path.0]).await?;

        // Nothing staged for this path (unchanged) → don't create an empty commit.
        let staged = self
            .git(&["status", "--porcelain", "--", &path.0])
            .await?;
        if staged.trim().is_empty() {
            return self.head().await;
        }
        self.commit_path(&path.0, &commit.message, &commit.author_did).await
    }

    /// Revert one file to its prior committed version — the ONE rollback case (PRD §7.5):
    /// a malformed skill/stimulus that broke a run. If the file has earlier history, check
    /// out the parent version; if it was only ever introduced once, remove it. The revert
    /// is itself committed (harness-authored).
    pub async fn revert_file(&self, path: &RepoPath) -> Result<CommitId> {
        let log = self
            .git(&["log", "-n", "2", "--format=%H", "--", &path.0])
            .await?;
        let hashes: Vec<&str> = log.lines().filter(|l| !l.is_empty()).collect();
        if hashes.len() >= 2 {
            // Restore the version from the commit before the latest one touching the path.
            self.git(&["checkout", hashes[1], "--", &path.0]).await?;
        } else {
            // Only one commit ever introduced it → the prior state is "absent".
            self.git(&["rm", "-f", "--", &path.0]).await?;
        }
        let author = self.default_author.clone();
        self.commit_path(&path.0, &format!("revert malformed {}", path.0), &author)
            .await
    }

    /// List files under `path` (filesystem walk, `.git` excluded) to `max_depth` relative
    /// to `path` — used by the `stimuli/` walker (depth ≤ 2, PRD §5.1) and memory `ls`.
    pub async fn list_dir(&self, path: &RepoPath, max_depth: usize) -> Result<Vec<RepoPath>> {
        let root = self.workdir.join(&path.0);
        let mut out = Vec::new();
        // Iterative walk to avoid async recursion. Stack of (abs_dir, depth).
        let mut stack = vec![(root.clone(), 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            let mut rd = match tokio::fs::read_dir(&dir).await {
                Ok(rd) => rd,
                Err(_) => continue, // path may not exist yet
            };
            while let Some(entry) = rd
                .next_entry()
                .await
                .map_err(|e| DackError::Repo(format!("readdir: {e}")))?
            {
                let name = entry.file_name();
                if name == ".git" {
                    continue;
                }
                let abs = entry.path();
                let ft = entry
                    .file_type()
                    .await
                    .map_err(|e| DackError::Repo(format!("filetype: {e}")))?;
                if ft.is_dir() {
                    if depth + 1 <= max_depth {
                        stack.push((abs, depth + 1));
                    }
                } else if let Ok(rel) = abs.strip_prefix(&self.workdir) {
                    out.push(RepoPath(rel.to_string_lossy().into_owned()));
                }
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    /// Commit a single pathspec attributed to `author_did` (author + committer), with no
    /// dependence on global git config.
    async fn commit_path(&self, path: &str, message: &str, author_did: &str) -> Result<CommitId> {
        let name = format!("user.name={author_did}");
        let email = format!("user.email={author_did}@dack");
        self.git(&[
            "-c", &name, "-c", &email, "commit", "-m", message, "--", path,
        ])
        .await?;
        self.head().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn init_repo() -> PathBuf {
        // A throwaway repo under the system temp dir (no tempfile crate dependency).
        let dir = std::env::temp_dir().join(format!("dack-gitcore-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.name", "seed"],
            vec!["config", "user.email", "seed@dack"],
        ] {
            Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(&args)
                .output()
                .await
                .unwrap();
        }
        dir
    }

    #[tokio::test]
    async fn write_read_list_and_revert_round_trip() {
        let dir = init_repo().await;
        let core = GitCore::new(&dir, "did:key:zSoul");
        let path = RepoPath("memory/log.md".into());
        let meta = |m: &str| CommitMeta {
            message: m.into(),
            author_did: "did:key:zSoul".into(),
        };

        // v1
        core.write_file(&path, b"first\n", &meta("first")).await.unwrap();
        assert_eq!(core.read_file(&path).await.unwrap(), b"first\n");

        // unchanged write → no new commit (idempotent)
        let h1 = core.write_file(&path, b"first\n", &meta("noop")).await.unwrap();
        let h1b = core.write_file(&path, b"first\n", &meta("noop")).await.unwrap();
        assert_eq!(h1, h1b, "unchanged content must not create a new commit");

        // v2
        core.write_file(&path, b"second\n", &meta("second")).await.unwrap();
        assert_eq!(core.read_file(&path).await.unwrap(), b"second\n");

        // list_dir sees the file
        let listed = core.list_dir(&RepoPath("memory".into()), 2).await.unwrap();
        assert!(listed.iter().any(|p| p.0 == "memory/log.md"));

        // revert v2 → back to v1 (the malformed-file rollback case)
        core.revert_file(&path).await.unwrap();
        assert_eq!(core.read_file(&path).await.unwrap(), b"first\n");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
