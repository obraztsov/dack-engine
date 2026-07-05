//! SQLite + FTS5 runlog store — the runlog backend for harness **v0.2.0**. Replaces the markdown
//! day-files + `tag-notes.ndjson`. Lives OUTSIDE the soul (a `runlog_db` path in the harness cwd), is
//! harness-authored (the agent still can NEVER write it), and is read by two sides: this harness (for
//! context-assembly, via [`RunLogWriter`]) and the recall MCPs (read-only, via `bun:sqlite`, directly).
//!
//! Threading mirrors the queue: `rusqlite::Connection` is `Send` but `!Sync`, so a `Mutex<Connection>`
//! makes it `Send + Sync`; the SQL calls are brief and never `.await` while the lock is held. WAL +
//! `busy_timeout` let the recall MCP readers run concurrently with the harness writer.
//!
//! Denormalization: each entry stores its structured fields (`thought` / `sent` / `incoming` / `trust`
//! / tags) AND a pre-rendered `heading` + `safe_body` (the render MINUS the untrusted raw fence) so the
//! Rust context reads are a plain `SELECT` while the FTS + the MCP reads work off the columns.

use std::collections::BTreeMap;
use std::sync::Mutex;

use async_trait::async_trait;
use rusqlite::{params, Connection};

use super::{EntryMetaRecord, RunLogWriter, RunlogStats, TagNoteRecord};
use crate::error::{DackError, Result};
use crate::model::runlog::{Outcome, RunLogEntry, ToolCallRecord};

fn db(e: rusqlite::Error) -> DackError {
    DackError::Runlog(e.to_string())
}

/// `ts` (unix secs) → `YYYY-MM-DD` (UTC) — the retention/day-stats bucket.
fn day_of(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS entries (
  rowid INTEGER PRIMARY KEY,
  run_id TEXT UNIQUE NOT NULL,
  stimulus_id TEXT, source TEXT NOT NULL, state TEXT NOT NULL,
  trust TEXT NOT NULL, outcome TEXT NOT NULL,
  ts INTEGER NOT NULL, day TEXT NOT NULL,
  context_summary TEXT,
  thought TEXT, sent TEXT, incoming TEXT,
  heading TEXT NOT NULL, safe_body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_ts ON entries(ts);
CREATE INDEX IF NOT EXISTS idx_entries_day ON entries(day);

CREATE TABLE IF NOT EXISTS entry_tags (
  run_id TEXT NOT NULL REFERENCES entries(run_id) ON DELETE CASCADE,
  tag TEXT NOT NULL, ts INTEGER NOT NULL,
  PRIMARY KEY (run_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_entry_tags_tag_ts ON entry_tags(tag, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  thought, sent, incoming, tokenize='porter unicode61'
);

CREATE TABLE IF NOT EXISTS tag_notes (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL, note TEXT NOT NULL, trust TEXT NOT NULL, ts INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE TABLE IF NOT EXISTS note_tags (
  note_id INTEGER NOT NULL REFERENCES tag_notes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag);
CREATE INDEX IF NOT EXISTS idx_tag_notes_kind_ts ON tag_notes(kind, ts);
";

pub struct SqliteRunLog {
    conn: Mutex<Connection>,
}

/// The rendered parts of an entry, computed once at append time.
struct Rendered {
    heading: String,
    safe_body: String,
    thought: String,
    sent: Vec<String>,
    incoming: String,
}

/// A backfilled entry parsed out of an old markdown day-file (the B1 conversion). Carries the exact
/// original rendered `heading`/`safe_body` plus the denormalized columns.
pub struct ImportedEntry {
    pub run_id: String,
    pub source: String,
    pub state: String,
    pub trust: String,
    pub outcome: String,
    pub ts: i64,
    pub context_summary: String,
    pub thought: String,
    pub sent: Vec<String>,
    pub incoming: String,
    pub heading: String,
    pub safe_body: String,
    pub tags: Vec<String>,
}

impl SqliteRunLog {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self> {
        Self::init(Connection::open(path).map_err(db)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory().map_err(db)?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout=5000;
             PRAGMA foreign_keys=ON;",
        )
        .map_err(db)?;
        conn.execute_batch(SCHEMA).map_err(db)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    // ── new query surface (used by context-assembly co-tags + the B2 recall MCPs / tests) ──

    /// FTS5 search over the given columns (`thought`/`sent`/`incoming`) — the trust boundary is the
    /// CALLER's column choice: self-recall passes `["thought","sent"]` (never `incoming`), raw-search
    /// passes `["incoming"]`. Returns matching `run_id`s, best-ranked first.
    pub fn search(&self, query: &str, columns: &[&str], limit: usize) -> Result<Vec<String>> {
        // Column-scoped FTS: `{thought sent} : (query)`. The query is a bound parameter (no injection).
        let scoped = format!("{{{}}} : ({})", columns.join(" "), query);
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT e.run_id FROM entries_fts f
                 JOIN entries e ON e.rowid = f.rowid
                 WHERE entries_fts MATCH ?1 ORDER BY rank LIMIT ?2",
            )
            .map_err(db)?;
        let rows = stmt
            .query_map(params![scoped, limit as i64], |r| r.get::<_, String>(0))
            .map_err(db)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(db)
    }

    /// Tag-intersection (co-occurrence): the tags on entries that ALSO carry `tag`, most-frequent first.
    /// Powers the `environment` co-tags line and the `related_tags` recall tool.
    pub fn related_tags(&self, tag: &str, limit: usize) -> Result<Vec<(String, usize, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT b.tag, COUNT(*) n, MAX(b.ts) last_seen
                 FROM entry_tags a JOIN entry_tags b ON a.run_id = b.run_id
                 WHERE a.tag = ?1 AND b.tag != ?1
                 GROUP BY b.tag ORDER BY n DESC, last_seen DESC LIMIT ?2",
            )
            .map_err(db)?;
        let rows = stmt
            .query_map(params![tag, limit as i64], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize, r.get::<_, i64>(2)?))
            })
            .map_err(db)?;
        rows.collect::<std::result::Result<Vec<_>, _>>().map_err(db)
    }

    /// Hard garbage collection (the multi-GB guard): delete entries older than `entry_days` and any
    /// tag-note older than `note_days`. Returns `(entries_deleted, notes_deleted)`. FTS + child rows are
    /// swept alongside (`entry_tags`/`note_tags` cascade; the FTS row is deleted explicitly). The trait
    /// [`hard_gc`](RunLogWriter::hard_gc) wraps this with the current time.
    pub fn gc(&self, entry_days: i64, note_days: i64, now: i64) -> Result<(usize, usize)> {
        let conn = self.conn.lock().unwrap();
        let entry_cut = day_of(now - entry_days * 86_400);
        // FTS first (no FK to cascade it), keyed on the rows about to go.
        conn.execute(
            "DELETE FROM entries_fts WHERE rowid IN (SELECT rowid FROM entries WHERE day < ?1)",
            params![entry_cut],
        )
        .map_err(db)?;
        let e = conn
            .execute("DELETE FROM entries WHERE day < ?1", params![entry_cut])
            .map_err(db)?;
        let n = conn
            .execute("DELETE FROM tag_notes WHERE ts < ?1", params![now - note_days * 86_400])
            .map_err(db)?;
        Ok((e, n))
    }

    /// Mark all PENDING (`delivered_at IS NULL`) `digest` notes tagged with any of `tags` as delivered —
    /// the retire step after a channel/Reflect digest cycle succeeds. Returns the count retired.
    pub fn mark_digest_delivered(&self, tags: &[&str], now: i64) -> Result<usize> {
        if tags.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().unwrap();
        let placeholders = vec!["?"; tags.len()].join(",");
        let sql = format!(
            "UPDATE tag_notes SET delivered_at = ? WHERE kind = 'digest' AND delivered_at IS NULL
             AND id IN (SELECT note_id FROM note_tags WHERE tag IN ({placeholders}))"
        );
        let mut binds: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(tags.len() + 1);
        binds.push(&now);
        for t in tags {
            binds.push(t);
        }
        conn.execute(&sql, binds.as_slice()).map_err(db)
    }

    /// One-shot BACKFILL import (the md→SQLite conversion) — insert an entry from already-parsed +
    /// already-rendered parts (the original day-file block, minus the raw fence). Idempotent on
    /// `run_id` (a re-run skips existing rows), so the migration can be re-run safely. Distinct from
    /// [`insert`](Self::insert): no re-render, so the exact original `safe_body` (proposal/batons/tool
    /// audit) is preserved verbatim.
    pub fn import_entry(&self, e: &ImportedEntry) -> Result<bool> {
        use rusqlite::OptionalExtension;
        let day = day_of(e.ts);
        let sent_json = serde_json::to_string(&e.sent).unwrap_or_else(|_| "[]".into());
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(db)?;
        let exists: Option<i64> = tx
            .query_row("SELECT rowid FROM entries WHERE run_id = ?1", params![e.run_id], |r| r.get(0))
            .optional()
            .map_err(db)?;
        if exists.is_some() {
            return Ok(false); // already imported — idempotent skip
        }
        tx.execute(
            "INSERT INTO entries
               (run_id, stimulus_id, source, state, trust, outcome, ts, day,
                context_summary, thought, sent, incoming, heading, safe_body)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                e.run_id, "", e.source, e.state, e.trust, e.outcome, e.ts, day,
                e.context_summary, e.thought, sent_json, e.incoming, e.heading, e.safe_body,
            ],
        )
        .map_err(db)?;
        let rowid = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO entries_fts (rowid, thought, sent, incoming) VALUES (?1,?2,?3,?4)",
            params![rowid, e.thought, e.sent.join(" "), e.incoming],
        )
        .map_err(db)?;
        for t in &e.tags {
            tx.execute(
                "INSERT OR IGNORE INTO entry_tags (run_id, tag, ts) VALUES (?1,?2,?3)",
                params![e.run_id, t, e.ts],
            )
            .map_err(db)?;
        }
        tx.commit().map_err(db)?;
        Ok(true)
    }

    /// One-shot BACKFILL import of a `tag-notes.ndjson` note (as a `memory` note). Idempotent on
    /// `(tag, note, ts)` so a re-run doesn't duplicate.
    pub fn import_note(&self, tag: &str, note: &str, trust: &str, ts: i64) -> Result<bool> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(db)?;
        let dup: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM tag_notes n JOIN note_tags nt ON nt.note_id = n.id
                 WHERE nt.tag = ?1 AND n.note = ?2 AND n.ts = ?3",
                params![tag, note, ts],
                |r| r.get(0),
            )
            .map_err(db)?;
        if dup > 0 {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO tag_notes (kind, note, trust, ts, delivered_at) VALUES ('memory', ?1, ?2, ?3, NULL)",
            params![note, trust, ts],
        )
        .map_err(db)?;
        let id = tx.last_insert_rowid();
        tx.execute("INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?1, ?2)", params![id, tag])
            .map_err(db)?;
        tx.commit().map_err(db)?;
        Ok(true)
    }

    // ── internal helpers ──

    fn insert(&self, entry: &RunLogEntry) -> Result<()> {
        let r = render(entry);
        let day = day_of(entry.timestamp);
        let sent_json = serde_json::to_string(&r.sent).unwrap_or_else(|_| "[]".into());
        use rusqlite::OptionalExtension;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(db)?;
        // A retry may re-append the same run_id: drop the prior row (cascades `entry_tags`) + its FTS row
        // first, so we never orphan a stale FTS entry (standalone fts5 has no FK to cascade it).
        if let Some(old) = tx
            .query_row("SELECT rowid FROM entries WHERE run_id = ?1", params![entry.run_id], |r| r.get::<_, i64>(0))
            .optional()
            .map_err(db)?
        {
            tx.execute("DELETE FROM entries_fts WHERE rowid = ?1", params![old]).map_err(db)?;
            tx.execute("DELETE FROM entries WHERE run_id = ?1", params![entry.run_id]).map_err(db)?;
        }
        tx.execute(
            "INSERT INTO entries
               (run_id, stimulus_id, source, state, trust, outcome, ts, day,
                context_summary, thought, sent, incoming, heading, safe_body)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                entry.run_id,
                entry.stimulus_id.0,
                entry.source,
                format!("{:?}", entry.state),
                entry.trust,
                match &entry.outcome {
                    Outcome::Ok => "OK".to_string(),
                    Outcome::Error(d) => format!("ERROR: {d}"),
                },
                entry.timestamp,
                day,
                entry.context_summary,
                r.thought,
                sent_json,
                r.incoming,
                r.heading,
                r.safe_body,
            ],
        )
        .map_err(db)?;
        let rowid = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO entries_fts (rowid, thought, sent, incoming) VALUES (?1,?2,?3,?4)",
            params![rowid, r.thought, r.sent.join(" "), r.incoming],
        )
        .map_err(db)?;
        for t in &entry.tags {
            tx.execute(
                "INSERT OR IGNORE INTO entry_tags (run_id, tag, ts) VALUES (?1,?2,?3)",
                params![entry.run_id, t, entry.timestamp],
            )
            .map_err(db)?;
        }
        tx.commit().map_err(db)?;
        Ok(())
    }

    /// Shared SELECT for the tail readers: entries matching the optional `since`/`tag` gates, newest
    /// `max` first, returned OLDEST→newest. `col` is an internal literal (`heading`/`safe_body`), never
    /// user input, so interpolating it is safe; the gate values are bound.
    fn tail_rows(&self, col: &str, since: Option<i64>, max: usize, tag: Option<&str>) -> Result<Vec<String>> {
        let since_v = since;
        let tag_v = tag.map(str::to_string);
        let max_v = max as i64;
        let mut sql = format!("SELECT {col} FROM entries WHERE 1=1");
        let mut binds: Vec<&dyn rusqlite::ToSql> = Vec::new();
        if let Some(s) = &since_v {
            binds.push(s);
            sql.push_str(&format!(" AND ts > ?{}", binds.len()));
        }
        if let Some(t) = &tag_v {
            binds.push(t);
            sql.push_str(&format!(" AND run_id IN (SELECT run_id FROM entry_tags WHERE tag = ?{})", binds.len()));
        }
        binds.push(&max_v);
        sql.push_str(&format!(" ORDER BY ts DESC LIMIT ?{}", binds.len()));
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql).map_err(db)?;
        let rows = stmt.query_map(binds.as_slice(), |r| r.get::<_, String>(0)).map_err(db)?;
        let mut v = rows.collect::<std::result::Result<Vec<_>, _>>().map_err(db)?;
        v.reverse(); // DESC fetch → chronological output
        Ok(v)
    }
}

/// Render an entry's heading + safe body (no raw fence) + the denormalized thought/sent/incoming — the
/// v0.2.0 owner of the format the file backend used to produce.
fn render(entry: &RunLogEntry) -> Rendered {
    let outcome_tag = match &entry.outcome {
        Outcome::Ok => "OK".to_string(),
        Outcome::Error(d) => format!("ERROR: {d}"),
    };
    let heading = format!(
        "## {} · {:?} · {} — {}",
        entry.run_id, entry.state, outcome_tag, entry.context_summary
    );
    let thought = entry.output.as_ref().map(|o| o.thought.replace('\n', " ")).unwrap_or_default();
    let sent = extract_sent(&entry.tool_calls);

    let mut body = String::new();
    body.push_str(&heading);
    body.push('\n');
    body.push_str(&format!("- timestamp: {}\n", entry.timestamp));
    if !entry.source.is_empty() {
        body.push_str(&format!("- source: {}\n", entry.source));
    }
    if !entry.tags.is_empty() {
        body.push_str(&format!("- tags: {}\n", entry.tags.join(", ")));
    }
    if let Some(out) = &entry.output {
        body.push_str(&format!("- thought: {}\n", out.thought.replace('\n', " ")));
        if let Some(p) = &out.proposal {
            body.push_str(&format!("- proposal: {:?} — {}\n", p.intent, p.gist));
        }
        if !out.batons.is_empty() {
            body.push_str("- batons:\n");
            for b in &out.batons {
                let rt = match &b.reply_to {
                    Some(r) => format!("reply_to={r}"),
                    None => "reply_to=(latest)".to_string(),
                };
                body.push_str(&format!("  - → {} [{rt}]: {}\n", b.to_prompt, b.gist.replace('\n', " ")));
            }
        }
    }
    if !entry.tool_calls.is_empty() {
        body.push_str("- tool calls:\n");
        for tc in &entry.tool_calls {
            match &tc.input {
                Some(inp) => body.push_str(&format!("  - `{}` {} → {}\n", tc.tool, inp.replace('\n', " "), tc.decision)),
                None => body.push_str(&format!("  - `{}` → {}\n", tc.tool, tc.decision)),
            }
        }
    }
    Rendered { heading, safe_body: body, thought, sent, incoming: entry.raw_stimulus.clone() }
}

/// The outward text this cycle SENT — the `text` field of every allowed reply/post/send tool-call.
/// Mirrors the TS `replyText` extraction so recall + FTS see the same `sent`.
fn extract_sent(tool_calls: &[ToolCallRecord]) -> Vec<String> {
    let mut out = Vec::new();
    for tc in tool_calls {
        let outward = tc.tool.contains("reply") || tc.tool.contains("post") || tc.tool.contains("send_message");
        if !outward {
            continue;
        }
        if let Some(inp) = &tc.input {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(inp) {
                if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
                    out.push(t.to_string());
                }
            }
        }
    }
    out
}

/// Collapse consecutive identical lines (a runlog tail is often N identical headings).
fn dedup_consecutive(lines: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for l in lines {
        if out.last().map(|p| p != l).unwrap_or(true) {
            out.push(l.clone());
        }
    }
    out
}

#[async_trait]
impl RunLogWriter for SqliteRunLog {
    async fn append(&self, entry: &RunLogEntry) -> Result<String> {
        self.insert(entry)?;
        Ok(format!("runlog#{}", entry.run_id))
    }

    async fn tail(&self, max_entries: usize) -> Result<String> {
        Ok(self.tail_rows("safe_body", None, max_entries, None)?.join("\n"))
    }

    async fn tail_filtered(&self, since: Option<i64>, max_entries: usize, tag: Option<&str>) -> Result<String> {
        let rows = self.tail_rows("heading", since, max_entries, tag)?;
        Ok(dedup_consecutive(&rows).join("\n"))
    }

    async fn tail_entries(&self, since: Option<i64>, max_entries: usize, tag: Option<&str>) -> Result<String> {
        Ok(self.tail_rows("safe_body", since, max_entries, tag)?.join("\n"))
    }

    async fn day_meta(&self) -> Result<Vec<EntryMetaRecord>> {
        let today = day_of(chrono::Utc::now().timestamp());
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT run_id, heading, ts, source FROM entries WHERE day = ?1 ORDER BY ts")
            .map_err(db)?;
        let base = stmt
            .query_map(params![today], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?))
            })
            .map_err(db)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db)?;
        let mut out = Vec::with_capacity(base.len());
        for (run_id, heading, ts, source) in base {
            let mut tstmt = conn.prepare("SELECT tag FROM entry_tags WHERE run_id = ?1").map_err(db)?;
            let tags = tstmt
                .query_map(params![run_id], |r| r.get::<_, String>(0))
                .map_err(db)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(db)?;
            out.push(EntryMetaRecord { heading, timestamp: ts, source, tags });
        }
        Ok(out)
    }

    async fn stats(&self) -> Result<RunlogStats> {
        let conn = self.conn.lock().unwrap();
        let mut stats = RunlogStats::default();
        // runs / day
        let mut s = conn.prepare("SELECT day, COUNT(*) FROM entries GROUP BY day").map_err(db)?;
        for row in s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))).map_err(db)? {
            let (day, n) = row.map_err(db)?;
            stats.days.insert(day, n);
        }
        // source × day
        let mut s = conn
            .prepare("SELECT source, day, COUNT(*) FROM entries WHERE source != '' GROUP BY source, day")
            .map_err(db)?;
        for row in s
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? as usize)))
            .map_err(db)?
        {
            let (src, day, n) = row.map_err(db)?;
            stats.by_source.entry(src).or_default().insert(day, n);
        }
        // tag × day
        let mut s = conn
            .prepare(
                "SELECT et.tag, e.day, COUNT(*) FROM entry_tags et JOIN entries e ON e.run_id = et.run_id
                 GROUP BY et.tag, e.day",
            )
            .map_err(db)?;
        for row in s
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? as usize)))
            .map_err(db)?
        {
            let (tag, day, n) = row.map_err(db)?;
            stats.by_tag.entry(tag).or_default().insert(day, n);
        }
        Ok(stats)
    }

    async fn rebuild_stats(&self) -> Result<()> {
        Ok(()) // SQL computes stats on demand — no in-memory index to rebuild.
    }

    async fn tag_notes(
        &self,
        since: Option<i64>,
        tag: Option<&str>,
        latest_per_tag: bool,
        max: usize,
    ) -> Result<Vec<TagNoteRecord>> {
        let conn = self.conn.lock().unwrap();
        // One row per (note, its tag); B0 notes carry a single tag, so this is 1:1.
        let mut sql = String::from(
            "SELECT nt.tag, n.note, n.trust, n.ts FROM tag_notes n
             JOIN note_tags nt ON nt.note_id = n.id WHERE 1=1",
        );
        let since_v = since;
        let tag_v = tag.map(str::to_string);
        let mut binds: Vec<&dyn rusqlite::ToSql> = Vec::new();
        if let Some(s) = &since_v {
            binds.push(s);
            sql.push_str(&format!(" AND n.ts > ?{}", binds.len()));
        }
        if let Some(t) = &tag_v {
            binds.push(t);
            sql.push_str(&format!(" AND nt.tag = ?{}", binds.len()));
        }
        sql.push_str(" ORDER BY n.ts DESC");
        let mut stmt = conn.prepare(&sql).map_err(db)?;
        let all: Vec<(String, String, String, i64)> = stmt
            .query_map(binds.as_slice(), |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .map_err(db)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db)?;

        let mut out: Vec<TagNoteRecord> = Vec::new();
        if latest_per_tag {
            // Newest per tag, with a `[+N more]` dupes count of the rest.
            let mut counts: BTreeMap<String, usize> = BTreeMap::new();
            for (t, ..) in &all {
                *counts.entry(t.clone()).or_default() += 1;
            }
            let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
            for (t, note, trust, ts) in all {
                if seen.insert(t.clone()) {
                    let dupes = counts.get(&t).copied().unwrap_or(1).saturating_sub(1);
                    out.push(TagNoteRecord { tag: t, note, trust, timestamp: ts, dupes });
                }
            }
        } else {
            for (t, note, trust, ts) in all {
                out.push(TagNoteRecord { tag: t, note, trust, timestamp: ts, dupes: 0 });
            }
        }
        out.truncate(max);
        Ok(out)
    }

    async fn append_note(
        &self,
        kind: &str,
        tags: &[&str],
        note: &str,
        trust: &str,
        timestamp: i64,
    ) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(db)?;
        tx.execute(
            "INSERT INTO tag_notes (kind, note, trust, ts, delivered_at) VALUES (?1, ?2, ?3, ?4, NULL)",
            params![kind, note, trust, timestamp],
        )
        .map_err(db)?;
        let id = tx.last_insert_rowid();
        for t in tags {
            tx.execute("INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?1, ?2)", params![id, t])
                .map_err(db)?;
        }
        tx.commit().map_err(db)?;
        Ok(())
    }

    async fn hard_gc(&self, entry_days: u64, note_days: u64) -> Result<(usize, usize)> {
        let now = chrono::Utc::now().timestamp();
        self.gc(entry_days as i64, note_days as i64, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::proposal::{AgentOutput, BatonIntent};
    use crate::model::runlog::ToolCallRecord;
    use crate::model::stimulus::StimulusId;
    use crate::state::ConsciousnessState;

    fn entry(run_id: &str, ts: i64, trust: &str, tags: &[&str], thought: &str, incoming: &str) -> RunLogEntry {
        RunLogEntry {
            run_id: run_id.into(),
            stimulus_id: StimulusId("s".into()),
            source: "telegram-pub".into(),
            state: ConsciousnessState::Perceive,
            context_summary: "ctx".into(),
            baton: None,
            raw_stimulus: incoming.into(),
            tool_calls: vec![ToolCallRecord {
                tool: "mcp__telegram__reply".into(),
                decision: "allow".into(),
                input: Some(format!("{{\"text\":\"replied to {run_id}\"}}")),
            }],
            output: Some(AgentOutput {
                thought: thought.into(),
                proposal: None,
                batons: Vec::<BatonIntent>::new(),
                ..Default::default()
            }),
            outcome: Outcome::Ok,
            timestamp: ts,
            tags: tags.iter().map(|s| s.to_string()).collect(),
            trust: trust.into(),
        }
    }

    #[tokio::test]
    async fn append_then_read_round_trips_body_tags_trust_and_sent() {
        let rl = SqliteRunLog::open_in_memory().unwrap();
        rl.append(&entry("run-a", 1000, "public", &["chatX"], "hmm a duck", "{\"text\":\"hi\"}")).await.unwrap();
        let body = rl.tail_entries(None, 10, Some("chatX")).await.unwrap();
        assert!(body.contains("## run-a"), "heading present");
        assert!(body.contains("- thought: hmm a duck"));
        assert!(!body.contains("```untrusted"), "safe body NEVER carries the raw fence");
        // trust + sent stored in columns
        let conn = rl.conn.lock().unwrap();
        let (trust, sent): (String, String) = conn
            .query_row("SELECT trust, sent FROM entries WHERE run_id='run-a'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(trust, "public");
        assert!(sent.contains("replied to run-a"), "outward text extracted into `sent`");
    }

    #[tokio::test]
    async fn fts_search_is_column_scoped_for_the_trust_boundary() {
        let rl = SqliteRunLog::open_in_memory().unwrap();
        // thought has "quack"; incoming (raw) has "banana".
        rl.append(&entry("run-q", 1000, "self", &["t"], "the duck quacks", "banana bread recipe")).await.unwrap();

        // SELF scope (thought+sent) finds "quack", must NOT find the untrusted "banana".
        assert_eq!(rl.search("quack", &["thought", "sent"], 10).unwrap(), vec!["run-q".to_string()]);
        assert!(rl.search("banana", &["thought", "sent"], 10).unwrap().is_empty(), "self never matches raw incoming");
        // RAW scope (incoming only) is where 'what the user said' lives.
        assert_eq!(rl.search("banana", &["incoming"], 10).unwrap(), vec!["run-q".to_string()]);
    }

    #[tokio::test]
    async fn related_tags_returns_cooccurrence() {
        let rl = SqliteRunLog::open_in_memory().unwrap();
        rl.append(&entry("r1", 1000, "public", &["chatX", "telegram"], "a", "x")).await.unwrap();
        rl.append(&entry("r2", 1001, "public", &["chatX", "telegram", "trading"], "b", "y")).await.unwrap();
        let co = rl.related_tags("chatX", 10).unwrap();
        let tags: Vec<&str> = co.iter().map(|(t, ..)| t.as_str()).collect();
        assert!(tags.contains(&"telegram") && tags.contains(&"trading"));
        // telegram co-occurs twice, trading once → telegram ranks first.
        assert_eq!(co[0].0, "telegram");
        assert_eq!(co[0].1, 2);
    }

    #[tokio::test]
    async fn tag_notes_latest_per_tag_counts_dupes() {
        let rl = SqliteRunLog::open_in_memory().unwrap();
        rl.append_note("memory", &["chatX"], "note one", "org", 1000).await.unwrap();
        rl.append_note("memory", &["chatX"], "note two", "org", 1001).await.unwrap();
        rl.append_note("memory", &["chatY"], "other", "public", 1002).await.unwrap();
        let latest = rl.tag_notes(None, Some("chatX"), true, 50).await.unwrap();
        assert_eq!(latest.len(), 1);
        assert_eq!(latest[0].note, "note two", "newest per tag");
        assert_eq!(latest[0].dupes, 1, "[+1 more]");
        // all-notes view (no collapse)
        assert_eq!(rl.tag_notes(None, None, false, 50).await.unwrap().len(), 3);
    }

    #[tokio::test]
    async fn stats_and_hard_gc() {
        let rl = SqliteRunLog::open_in_memory().unwrap();
        let now = chrono::Utc::now().timestamp();
        rl.append(&entry("recent", now, "self", &["t"], "a", "x")).await.unwrap();
        rl.append(&entry("old", now - 40 * 86_400, "self", &["t"], "b", "y")).await.unwrap();
        // stats see both days
        assert_eq!(rl.stats().await.unwrap().days.len(), 2);
        // hard GC: entries > 30d gone, note ceiling 90d
        let (entries_del, _) = rl.gc(30, 90, now).unwrap();
        assert_eq!(entries_del, 1, "the 40-day-old entry is swept");
        // its FTS row went too
        assert!(rl.search("b", &["thought"], 10).unwrap().is_empty(), "GC swept the FTS row");
        assert_eq!(rl.search("a", &["thought"], 10).unwrap(), vec!["recent".to_string()]);
    }

    #[tokio::test]
    async fn append_note_writes_typed_multi_tag_notes() {
        let rl = SqliteRunLog::open_in_memory().unwrap();
        // a digest note tagged with its thread AND its channel (M:N)
        rl.append_note("digest", &["chatX", "telegram"], "summarize chatX", "self", 1000).await.unwrap();
        rl.append_note("memory", &["chatX"], "al likes ducks", "org", 1001).await.unwrap();
        // both of the digest note's tags resolve to it
        assert_eq!(rl.tag_notes(None, Some("telegram"), false, 10).await.unwrap().len(), 1);
        assert_eq!(rl.tag_notes(None, Some("chatX"), false, 10).await.unwrap().len(), 2, "chatX has the digest + memory note");
        // the digest note retires via its channel tag; the memory note is untouched
        assert_eq!(rl.mark_digest_delivered(&["telegram"], 2000).unwrap(), 1);
        assert_eq!(rl.mark_digest_delivered(&["telegram"], 3000).unwrap(), 0, "idempotent");
    }

    #[tokio::test]
    async fn digest_delivery_marking() {
        let rl = SqliteRunLog::open_in_memory().unwrap();
        // a digest note tagged telegram (write directly for the B0 test)
        {
            let mut conn = rl.conn.lock().unwrap();
            let tx = conn.transaction().unwrap();
            tx.execute("INSERT INTO tag_notes (kind, note, trust, ts, delivered_at) VALUES ('digest','d','self',1000,NULL)", []).unwrap();
            let id = tx.last_insert_rowid();
            tx.execute("INSERT INTO note_tags (note_id, tag) VALUES (?1,'telegram')", params![id]).unwrap();
            tx.commit().unwrap();
        }
        let n = rl.mark_digest_delivered(&["telegram"], 2000).unwrap();
        assert_eq!(n, 1);
        // idempotent — already delivered, not re-marked
        assert_eq!(rl.mark_digest_delivered(&["telegram"], 3000).unwrap(), 0);
    }
}
