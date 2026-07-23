//! Plain-git repo-host adapter — a single plain remote (GitHub / GitLab / self-hosted), and the base
//! of the corp variant (`GitHub/GitLab + Claude Code`).
//!
//! Fully functional: all operations delegate to the shared [`GitCore`]. The actor bundle is just a
//! git repo, so pushes (if a remote is set) use ordinary `git push`. (For multiple remotes, see
//! [`super::multi::MultiRemoteRepo`].)

use async_trait::async_trait;
use std::path::PathBuf;

use super::gitcore::GitCore;
use super::{CommitId, CommitMeta, RepoChange, RepoHost, RepoPath};
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
    async fn remove_file(&self, path: &RepoPath, commit: &CommitMeta) -> Result<CommitId> {
        self.core.remove(path, &commit.message, &commit.author_did).await
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
    /// Plain `git push` to the configured remote, or a no-op when none is set (offline / local-only).
    async fn push(&self) -> Result<()> {
        match &self.remote {
            Some(remote) => self.core.push(remote, &[]).await,
            None => Ok(()),
        }
    }
}
