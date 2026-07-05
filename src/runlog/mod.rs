//! RunLog — the harness-authored **short-term memory** seam. Append-only; the agent reads it through
//! the recall MCP tools but can NEVER write it (a compromised agent must not erase the evidence of its
//! own compromise). Errors are entries tagged `error` — no separate ErrorLog; Reflect reviews them.
//!
//! v0.2.0 backend: [`sqlite::SqliteRunLog`] (a single `runlogs.sqlite`, FTS5, outside the soul). The
//! [`migrate`] module does the one-time markdown→SQLite conversion. The old markdown day-file backend
//! is gone; the trait's default methods keep a minimal in-memory test writer possible.

use async_trait::async_trait;

use crate::error::Result;
use crate::model::runlog::RunLogEntry;

pub mod migrate;
pub mod sqlite;

#[async_trait]
pub trait RunLogWriter: Send + Sync {
    /// Append one entry and return its `runlog_ref` (`runlog#<run_id>`) for the Baton to point at.
    async fn append(&self, entry: &RunLogEntry) -> Result<String>;

    /// Read the recent tail for seeding into the invocation context and for `dack log`.
    async fn tail(&self, max_entries: usize) -> Result<String>;

    /// Filtered tail — the heading one-liners of entries, most-recent-capped at `max_entries`, optionally
    /// gated by time and/or tag:
    /// - `since = Some(ts)` keeps only entries with `timestamp > ts` (the "while you slept" diff); `None`
    ///   = no time gate (a plain recent tail).
    /// - `tag = Some(t)` keeps only entries whose `tags` contain `t` (a conversation/topic view); `None`
    ///   = the global view.
    /// Consecutive duplicates are collapsed. Empty when nothing matches.
    async fn tail_filtered(
        &self,
        since: Option<i64>,
        max_entries: usize,
        tag: Option<&str>,
    ) -> Result<String>;

    /// Full-entry tail (for the `thread` / `thread-recent` blocks): the SAFE bodies (thought + gist +
    /// batons + tool-input audit; NEVER the raw untrusted stimulus) of entries matching the optional
    /// `since`/`tag` gates, most-recent-capped at `max_entries`. Default falls back to the heading tail
    /// (minimal writers carry no bodies).
    async fn tail_entries(
        &self,
        since: Option<i64>,
        max_entries: usize,
        tag: Option<&str>,
    ) -> Result<String> {
        self.tail_filtered(since, max_entries, tag).await
    }

    /// Today's parsed entry metadata (heading + timestamp + source + tags), un-deduped — so a caller
    /// can derive today's co-tags (multi-day counts come from [`stats`](RunLogWriter::stats)). Default:
    /// empty (test writers).
    async fn day_meta(&self) -> Result<Vec<EntryMetaRecord>> {
        Ok(Vec::new())
    }

    /// Aggregate activity for the `environment` map (runs by day, cross-cut by source + tag). A
    /// runlog-implementation concern — the reader never parses files itself. Default: empty.
    async fn stats(&self) -> Result<RunlogStats> {
        Ok(RunlogStats::default())
    }

    /// Rebuild the aggregate [`stats`](RunLogWriter::stats) from persisted history. The SQLite backend
    /// computes stats on demand via SQL, so this is a no-op there. Default: no-op.
    async fn rebuild_stats(&self) -> Result<()> {
        Ok(())
    }

    /// Read tag-notes from the catalogue, newest-last, with optional gates: `since` (timestamp >),
    /// `tag` (exact match), `latest_per_tag` (collapse to the most-recent note per tag), capped to the
    /// most-recent `max` results. Default: empty (test writers).
    async fn tag_notes(
        &self,
        _since: Option<i64>,
        _tag: Option<&str>,
        _latest_per_tag: bool,
        _max: usize,
    ) -> Result<Vec<TagNoteRecord>> {
        Ok(Vec::new())
    }

    /// Append a "sticky note" to the SHORT-TERM tag-notes catalogue. Append-only + harness-authored (the
    /// agent can't write the runlog directly). `max` is legacy (retention is now the hard-GC ceiling).
    /// Default: no-op (test writers).
    async fn append_tag_note(
        &self,
        _tag: &str,
        _note: &str,
        _trust: &str,
        _timestamp: i64,
        _max: usize,
    ) -> Result<()> {
        Ok(())
    }

    /// Retention (legacy file backend): keep only the most recent `keep_days` of history. Default:
    /// no-op. Superseded by [`hard_gc`](RunLogWriter::hard_gc) on the SQLite backend.
    async fn prune_old_days(&self, _keep_days: u64) -> Result<usize> {
        Ok(0)
    }

    /// Hard garbage-collection ceiling (the multi-GB guard, v0.2.0 SQLite): delete entries older than
    /// `entry_days` and any tag-note older than `note_days`. Returns `(entries_deleted, notes_deleted)`.
    /// The SOFT surfaced window is separate (per-prompt frontmatter). Default: no-op.
    async fn hard_gc(&self, _entry_days: u64, _note_days: u64) -> Result<(usize, usize)> {
        Ok((0, 0))
    }
}

/// One parsed entry's metadata, OWNED (for the harness to derive counts / co-tags off-thread).
#[derive(Clone, Debug)]
pub struct EntryMetaRecord {
    pub heading: String,
    pub timestamp: i64,
    pub source: String,
    pub tags: Vec<String>,
}

/// Aggregate runlog activity for the `environment` map — counts bucketed by DAY, cross-cut by source
/// and by tag. A **runlog-implementation concern**: the SQLite backend computes it via SQL. The harness
/// only ever reads it via [`RunLogWriter::stats`].
#[derive(Clone, Debug, Default)]
pub struct RunlogStats {
    /// date (`YYYY-MM-DD`) → total runs that day.
    pub days: std::collections::BTreeMap<String, usize>,
    /// source → (date → count).
    pub by_source: std::collections::BTreeMap<String, std::collections::BTreeMap<String, usize>>,
    /// tag → (date → count).
    pub by_tag: std::collections::BTreeMap<String, std::collections::BTreeMap<String, usize>>,
}

/// One tag-note (a per-conversation "sticky note").
#[derive(Clone, Debug)]
pub struct TagNoteRecord {
    pub tag: String,
    pub note: String,
    pub trust: String,
    pub timestamp: i64,
    /// When collapsed latest-per-tag: how many OTHER notes exist for this tag (0 otherwise) — powers
    /// the `[+N more]` hint so the model knows there's un-shown history to drill into.
    pub dupes: usize,
}
