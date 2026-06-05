//! Repo-host seam (PRD §3.2, §3.4, §3.5). The core speaks **"commit to repo Y"**; the
//! actor bundle is *a git repo*, so the degraded-mode fallback is a plain git remote
//! with no state-logic change (PRD §3.5 — Gitlawb node software is pre-alpha).
//!
//! This is where the soul/memory/skills/runlogs live (off-VPS, PRD §2): durable state
//! with a different lifetime than the ephemeral SQLite queue.

use async_trait::async_trait;

use crate::error::Result;

/// A path within the actor bundle, e.g. `memory/log.md`, `skills/twitter/SKILL.md`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RepoPath(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitId(pub String);

/// Who authored a commit, and why. v1: all soul-repo commits are authored by the
/// harness on the duck's behalf, signed with the Soul DID (PRD §3.3).
#[derive(Debug, Clone)]
pub struct CommitMeta {
    pub message: String,
    /// The DID this commit is attributed to (Soul for soul-repo writes).
    pub author_did: String,
}

#[async_trait]
pub trait RepoHost: Send + Sync {
    async fn read_file(&self, path: &RepoPath) -> Result<Vec<u8>>;

    /// Write + commit in one ministerial step. The harness signs; the agent's tool
    /// call to write only *reaches* here after the `action_required` responder has
    /// confirmed the target dir is in the current state's `writable_dirs` (PRD §4.1).
    async fn write_file(&self, path: &RepoPath, contents: &[u8], commit: &CommitMeta)
        -> Result<CommitId>;

    /// List entries under `path` to `max_depth` — used by the `stimuli/` walker
    /// (depth ≤ 2, PRD §5.1) and by memory `ls`.
    async fn list_dir(&self, path: &RepoPath, max_depth: usize) -> Result<Vec<RepoPath>>;

    /// Revert a single file to its prior commit — the ONE rollback case (PRD §7.5):
    /// a run that fails to start because a skill/stimulus file is malformed.
    async fn revert_file(&self, path: &RepoPath) -> Result<CommitId>;
}

pub mod git;
pub mod gitcore;
pub mod gitlawb;
