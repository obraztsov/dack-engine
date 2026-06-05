//! RunLog writer (PRD §7.5) — **harness-authored, append-only, one file per day**
//! (`runlogs/YYYY-MM-DD.md`). The agent reads it via tool but can NEVER write it
//! (enforced by the responder, PRD §4.1): if the agent could write its own runlog, a
//! compromised agent could erase the evidence of its own compromise.
//!
//! Errors are entries tagged `error` — no separate ErrorLog store. Reflect reviews the
//! day's runlogs (including errors) and decides what to learn. Append-only is exempt
//! from rollback: the agent always wakes knowing *more* after a failure, never less.

use async_trait::async_trait;

use crate::error::Result;
use crate::model::runlog::RunLogEntry;

#[async_trait]
pub trait RunLogWriter: Send + Sync {
    /// Append one entry to today's runlog and return its `runlog_ref`
    /// (e.g. `runlogs/2026-05-29.md#run-0412`) for the Baton to point at (PRD §6.4).
    async fn append(&self, entry: &RunLogEntry) -> Result<String>;

    /// Read the recent tail for seeding into the invocation context (PRD §6.1) and for
    /// `dack log` (PRD §8.3).
    async fn tail(&self, max_entries: usize) -> Result<String>;
}

/// Daily-file writer over the [`RepoHost`](crate::repo::RepoHost) seam (durable, off-VPS).
/// SCAFFOLD: Phase 7 wires the markdown rendering + repo commits.
pub struct DailyFileRunLog {
    pub repo: std::sync::Arc<dyn crate::repo::RepoHost>,
}

#[async_trait]
impl RunLogWriter for DailyFileRunLog {
    async fn append(&self, _entry: &RunLogEntry) -> Result<String> {
        todo!("Phase 7: render entry to markdown, append to runlogs/<date>.md, commit, return ref")
    }
    async fn tail(&self, _max_entries: usize) -> Result<String> {
        todo!("Phase 7: read the tail of today's runlog file")
    }
}
