//! Plain-git repo-host adapter — the **degraded-mode fallback** (PRD §3.5) and the base
//! of the corp variant (`GitHub/GitLab + Claude Code`, PRD §3.4).
//!
//! Fully functional: all operations delegate to the shared [`GitCore`]. Because the actor
//! bundle is just a git repo, a plain remote (GitHub/GitLab/self-hosted) is a drop-in if
//! Gitlawb breaks mid-experiment — no state-logic change. Pushes (if a remote is set) use
//! ordinary `git push`; there is no Gitlawb signing here.

use async_trait::async_trait;
use std::path::PathBuf;

use super::gitcore::GitCore;
use super::{CommitId, CommitMeta, RepoHost, RepoPath};
use crate::error::Result;

pub struct PlainGitRepo {
    core: GitCore,
    /// Optional remote name to `git push` to after each commit (e.g. "origin").
    pub remote: Option<String>,
}

impl PlainGitRepo {
    /// `workdir` is the local working copy; `author_did` attributes commits.
    pub fn new(workdir: impl Into<PathBuf>, author_did: impl Into<String>) -> Self {
        Self {
            core: GitCore::new(workdir, author_did),
            remote: None,
        }
    }
}

#[async_trait]
impl RepoHost for PlainGitRepo {
    async fn read_file(&self, path: &RepoPath) -> Result<Vec<u8>> {
        self.core.read_file(path).await
    }
    async fn write_file(
        &self,
        path: &RepoPath,
        contents: &[u8],
        commit: &CommitMeta,
    ) -> Result<CommitId> {
        self.core.write_file(path, contents, commit).await
    }
    async fn list_dir(&self, path: &RepoPath, max_depth: usize) -> Result<Vec<RepoPath>> {
        self.core.list_dir(path, max_depth).await
    }
    async fn revert_file(&self, path: &RepoPath) -> Result<CommitId> {
        self.core.revert_file(path).await
    }
}
