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
use super::{CommitId, CommitMeta, RepoChange, RepoHost, RepoPath};
use crate::error::Result;

pub struct GitlawbRepo {
    core: GitCore,
    /// e.g. `gitlawb://<soul-did>/dack-soul` — the push remote served by git-remote-gitlawb.
    pub remote: String,
    /// The `gl` identity dir whose key signs pushes (the Soul dir; harness-only). The helper
    /// reads `GITLAWB_KEY=<identity_dir>/identity.pem` and the `ucan.json` beside it.
    pub identity_dir: PathBuf,
    /// The gitlawb node the helper pushes to (`GITLAWB_NODE`), e.g. `https://node.gitlawb.com`.
    pub node: String,
}

impl GitlawbRepo {
    pub fn new(
        workdir: impl Into<PathBuf>,
        author_did: impl Into<String>,
        remote: impl Into<String>,
        identity_dir: impl Into<PathBuf>,
        node: impl Into<String>,
    ) -> Self {
        Self {
            core: GitCore::new(workdir, author_did),
            remote: remote.into(),
            identity_dir: identity_dir.into(),
            node: node.into(),
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
    async fn status(&self) -> Result<Vec<RepoChange>> {
        self.core.status_porcelain().await
    }
    async fn commit_paths(
        &self,
        paths: &[RepoPath],
        commit: &CommitMeta,
    ) -> Result<Option<CommitId>> {
        self.core
            .commit_paths(paths, &commit.message, &commit.author_did)
            .await
    }
    async fn restore_to_head(&self, change: &RepoChange) -> Result<()> {
        self.core.restore_to_head(change).await
    }
    /// Signed `gitlawb://` push: the `git-remote-gitlawb` helper signs the ref-update with the
    /// Soul key at `GITLAWB_KEY` (never in agent env), pushing to `GITLAWB_NODE`. The Soul-DID
    /// commit *author* is attribution; THIS signature is the cryptographic provenance (PRD §3.3).
    async fn push(&self) -> Result<()> {
        let key = self.identity_dir.join("identity.pem");
        let env = [
            ("GITLAWB_KEY", key.to_string_lossy().into_owned()),
            ("GITLAWB_NODE", self.node.clone()),
        ];
        self.core.push(&self.remote, &env).await
    }
}
