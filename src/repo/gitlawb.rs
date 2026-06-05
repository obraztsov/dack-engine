//! Gitlawb repo-host adapter (PRD §3.1–§3.4) — v1 default.
//!
//! Grounded against `gl` 0.3.8: the *same* local git operations as [`PlainGitRepo`]
//! (shared [`GitCore`]), differing only in (a) the remote is a `gitlawb://` URL served by
//! the `git-remote-gitlawb` helper, and (b) `gl repo create` registers the repo on a node
//! first. The helper signs the ref-update with the identity in the configured `gl` dir on
//! push — so the Soul DID's key signs pushes without ever entering agent env (PRD §3.3).
//!
//! Local ops (read/write/commit/list/revert) work offline; push needs a reachable node
//! (`--node`, default `https://node.gitlawb.com`). Setup commands are in BUILD-PLAN Phase 2.

use async_trait::async_trait;
use std::path::PathBuf;

use super::gitcore::GitCore;
use super::{CommitId, CommitMeta, RepoHost, RepoPath};
use crate::error::Result;

pub struct GitlawbRepo {
    core: GitCore,
    /// e.g. `gitlawb://<soul-did>/dack-soul` — the push remote served by git-remote-gitlawb.
    pub remote: String,
    /// The `gl` identity dir whose key signs pushes (the Soul dir; harness-only).
    pub identity_dir: PathBuf,
}

impl GitlawbRepo {
    pub fn new(
        workdir: impl Into<PathBuf>,
        author_did: impl Into<String>,
        remote: impl Into<String>,
        identity_dir: impl Into<PathBuf>,
    ) -> Self {
        Self {
            core: GitCore::new(workdir, author_did),
            remote: remote.into(),
            identity_dir: identity_dir.into(),
        }
    }
}

#[async_trait]
impl RepoHost for GitlawbRepo {
    async fn read_file(&self, path: &RepoPath) -> Result<Vec<u8>> {
        self.core.read_file(path).await
    }
    async fn write_file(
        &self,
        path: &RepoPath,
        contents: &[u8],
        commit: &CommitMeta,
    ) -> Result<CommitId> {
        // Local commit is identical to plain git; the gitlawb:// push (signed by the helper
        // using `identity_dir`) is layered on in Phase 2 finish once a node is configured.
        self.core.write_file(path, contents, commit).await
    }
    async fn list_dir(&self, path: &RepoPath, max_depth: usize) -> Result<Vec<RepoPath>> {
        self.core.list_dir(path, max_depth).await
    }
    async fn revert_file(&self, path: &RepoPath) -> Result<CommitId> {
        self.core.revert_file(path).await
    }
}
