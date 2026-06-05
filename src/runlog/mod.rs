//! RunLog writer (PRD §7.5) — **harness-authored, append-only, one file per day**
//! (`runlogs/YYYY-MM-DD.md`). The agent reads it via tool but can NEVER write it
//! (enforced by the responder, PRD §4.1): if the agent could write its own runlog, a
//! compromised agent could erase the evidence of its own compromise.
//!
//! Errors are entries tagged `error` — no separate ErrorLog store. Reflect reviews the
//! day's runlogs (including errors) and decides what to learn. Append-only is exempt
//! from rollback: the agent always wakes knowing *more* after a failure, never less.

use std::path::PathBuf;

use async_trait::async_trait;
use tokio::io::AsyncWriteExt;

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

/// Minimal local-file writer (Phase 4) — appends a compact one-line record to
/// `<dir>/<date>.md`, no git commit (Phase 7 adds full markdown rendering + the
/// [`RepoHost`](crate::repo::RepoHost)-committed [`DailyFileRunLog`]). Enough to make the
/// dispatch loop produce a durable, tailable record now.
pub struct FileRunLog {
    /// The `runlogs/` directory.
    pub dir: PathBuf,
}

impl FileRunLog {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    fn today_path(&self) -> (String, PathBuf) {
        let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let path = self.dir.join(format!("{date}.md"));
        (date, path)
    }
}

#[async_trait]
impl RunLogWriter for FileRunLog {
    async fn append(&self, entry: &RunLogEntry) -> Result<String> {
        let (date, path) = self.today_path();
        tokio::fs::create_dir_all(&self.dir).await?;
        let line = format!(
            "- `{}` **{:?}** stim=`{}` outcome={:?} — {}\n",
            entry.run_id,
            entry.state,
            entry.stimulus_id.0,
            entry.outcome,
            entry.context_summary.replace('\n', " ")
        );
        let mut f = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;
        f.write_all(line.as_bytes()).await?;
        Ok(format!("runlogs/{date}.md#{}", entry.run_id))
    }

    async fn tail(&self, max_entries: usize) -> Result<String> {
        let (_, path) = self.today_path();
        let text = tokio::fs::read_to_string(&path).await.unwrap_or_default();
        let lines: Vec<&str> = text.lines().collect();
        let start = lines.len().saturating_sub(max_entries);
        Ok(lines[start..].join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::runlog::Outcome;
    use crate::model::stimulus::StimulusId;
    use crate::state::ConsciousnessState;

    fn entry(run_id: &str) -> RunLogEntry {
        RunLogEntry {
            run_id: run_id.into(),
            stimulus_id: StimulusId("s1".into()),
            state: ConsciousnessState::Perceive,
            context_summary: "directive_tier=SelfTier".into(),
            baton: None,
            raw_stimulus: "{}".into(),
            tool_calls: vec![],
            output: None,
            outcome: Outcome::Ok,
            timestamp: 1000,
        }
    }

    #[tokio::test]
    async fn appends_and_tails() {
        let dir = std::env::temp_dir().join(format!("dack-runlog-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let log = FileRunLog::new(&dir);

        let r1 = log.append(&entry("run-1")).await.unwrap();
        log.append(&entry("run-2")).await.unwrap();
        assert!(r1.ends_with("#run-1"));
        assert!(r1.starts_with("runlogs/"));

        let tail = log.tail(10).await.unwrap();
        assert!(tail.contains("run-1") && tail.contains("run-2"));
        assert_eq!(tail.lines().count(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }
}
