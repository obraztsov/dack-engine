//! SQLite-backed single-flight queue (PRD §5.6, §9.3) — the v1 durable store for the
//! ephemeral stimulus/dedup queue. `bundled` SQLite compiles in-tree (no system libsqlite),
//! keeping the box dependency-light. Losing this DB loses only the queue, never the soul
//! (that lives on Gitlawb, PRD §2).
//!
//! Threading: `rusqlite::Connection` is `Send` but `!Sync`, so a `Mutex<Connection>` is
//! `Send + Sync`. The queries are sub-millisecond and the harness is single-flight
//! (PRD §9.2), so taking the lock and doing synchronous SQLite work inside the async
//! methods (never holding the lock across an `.await`) is correct and simple.

use std::sync::Mutex;

use async_trait::async_trait;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{de::DeserializeOwned, Serialize};

use super::Queue;
use crate::error::{DackError, Result};
use crate::model::stimulus::{Stimulus, StimulusId, StimulusStatus, StimulusType};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS stimulus (
    id             TEXT PRIMARY KEY,
    source         TEXT NOT NULL,
    type           TEXT NOT NULL,
    directive_tier TEXT NOT NULL,
    payload_tier   TEXT NOT NULL,
    payload        TEXT NOT NULL,
    provenance     TEXT,
    received_at    INTEGER NOT NULL,
    dedup_key      TEXT,
    priority       TEXT NOT NULL,
    priority_rank  INTEGER NOT NULL,
    status         TEXT NOT NULL,
    directive_body TEXT NOT NULL,
    entry          TEXT NOT NULL,
    -- When `next()` leased this row (epoch secs). Queue-internal metadata (NOT on `Stimulus`):
    -- a boot sweep requeues `dispatched` rows; `started_at` dates the lease for future
    -- stale-lease detection. NULL until first dispatched.
    started_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_stimulus_dedup        ON stimulus(type, dedup_key);
CREATE INDEX IF NOT EXISTS idx_stimulus_status_rank  ON stimulus(status, priority_rank, received_at);

-- Cross-poll dedup watermarks (PRD §10.2): one row per duty cursor key.
CREATE TABLE IF NOT EXISTS cursor (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

/// The column list, in a fixed order shared by every SELECT and [`read_raw`].
const COLS: &str =
    "id,source,type,directive_tier,payload_tier,payload,provenance,received_at,dedup_key,priority,status,directive_body,entry";

pub struct SqliteQueue {
    conn: Mutex<Connection>,
}

impl SqliteQueue {
    /// Open (creating if absent) the queue DB at `path` and apply the schema.
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self> {
        Self::init(Connection::open(path).map_err(db)?)
    }

    /// An ephemeral in-memory queue — used by tests and as a degraded fallback.
    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory().map_err(db)?)
    }

    fn init(conn: Connection) -> Result<Self> {
        // WAL lets the Phase-4 consciousness loop read the queue while ingestion writes it
        // (concurrent reader + writer); busy_timeout rides out the brief writer lock instead
        // of erroring. `:memory:` ignores WAL — harmless for tests.
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA busy_timeout=5000;",
        )
        .map_err(db)?;
        conn.execute_batch(SCHEMA).map_err(db)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

fn db<E: std::fmt::Display>(e: E) -> DackError {
    DackError::Queue(e.to_string())
}

/// A serde-renamed enum (TrustTier, StimulusStatus, Priority, StimulusType newtype) →
/// its bare DB string. Single source of truth: the serde attrs, not a parallel table.
fn enum_to_db<T: Serialize>(v: &T) -> Result<String> {
    match serde_json::to_value(v)? {
        serde_json::Value::String(s) => Ok(s),
        other => Err(DackError::Queue(format!("expected string enum, got {other}"))),
    }
}

fn enum_from_db<T: DeserializeOwned>(s: &str) -> Result<T> {
    serde_json::from_value(serde_json::Value::String(s.to_string())).map_err(DackError::from)
}

/// All-string/int mirror of a row. Read inside the rusqlite closure (only infallible
/// `get`s), then converted to a [`Stimulus`] in normal code where `?`/`DackError` flow.
struct RawRow {
    id: String,
    source: String,
    type_: String,
    directive_tier: String,
    payload_tier: String,
    payload: String,
    provenance: Option<String>,
    received_at: i64,
    dedup_key: Option<String>,
    priority: String,
    status: String,
    directive_body: String,
    entry: String,
}

fn read_raw(row: &rusqlite::Row) -> rusqlite::Result<RawRow> {
    Ok(RawRow {
        id: row.get(0)?,
        source: row.get(1)?,
        type_: row.get(2)?,
        directive_tier: row.get(3)?,
        payload_tier: row.get(4)?,
        payload: row.get(5)?,
        provenance: row.get(6)?,
        received_at: row.get(7)?,
        dedup_key: row.get(8)?,
        priority: row.get(9)?,
        status: row.get(10)?,
        directive_body: row.get(11)?,
        entry: row.get(12)?,
    })
}

fn raw_to_stimulus(r: RawRow) -> Result<Stimulus> {
    Ok(Stimulus {
        id: StimulusId(r.id),
        source: r.source,
        type_: StimulusType(r.type_),
        directive_tier: enum_from_db(&r.directive_tier)?,
        payload_tier: enum_from_db(&r.payload_tier)?,
        payload: serde_json::from_str(&r.payload)?,
        provenance: r.provenance,
        received_at: r.received_at,
        dedup_key: r.dedup_key,
        priority: enum_from_db(&r.priority)?,
        status: enum_from_db(&r.status)?,
        directive_body: r.directive_body,
        entry: r.entry, // a plain state-prompt id (MCP2-B), stored verbatim.
    })
}

#[async_trait]
impl Queue for SqliteQueue {
    async fn enqueue(&self, s: Stimulus) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        // OR IGNORE: re-enqueuing the same id (e.g. a retried fire) is a no-op, never a dup.
        conn.execute(
            "INSERT OR IGNORE INTO stimulus
             (id,source,type,directive_tier,payload_tier,payload,provenance,received_at,dedup_key,priority,priority_rank,status,directive_body,entry)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                s.id.0,
                s.source,
                s.type_.0,
                enum_to_db(&s.directive_tier)?,
                enum_to_db(&s.payload_tier)?,
                s.payload.to_string(),
                s.provenance,
                s.received_at,
                s.dedup_key,
                enum_to_db(&s.priority)?,
                s.priority.numeric(),
                enum_to_db(&s.status)?,
                s.directive_body,
                s.entry,
            ],
        )
        .map_err(db)?;
        Ok(())
    }

    async fn next(&self) -> Result<Option<Stimulus>> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction().map_err(db)?;
        let raw = tx
            .query_row(
                &format!(
                    "SELECT {COLS} FROM stimulus WHERE status='pending'
                     ORDER BY priority_rank ASC, received_at ASC LIMIT 1"
                ),
                [],
                read_raw,
            )
            .optional()
            .map_err(db)?;
        let Some(raw) = raw else {
            tx.commit().map_err(db)?;
            return Ok(None);
        };
        tx.execute(
            "UPDATE stimulus SET status='dispatched', started_at=?2 WHERE id=?1",
            params![raw.id, chrono::Utc::now().timestamp()],
        )
        .map_err(db)?;
        tx.commit().map_err(db)?;
        let mut s = raw_to_stimulus(raw)?;
        s.status = StimulusStatus::Dispatched;
        Ok(Some(s))
    }

    async fn update_status(&self, id: &StimulusId, status: StimulusStatus) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE stimulus SET status=?1 WHERE id=?2",
            params![enum_to_db(&status)?, id.0],
        )
        .map_err(db)?;
        Ok(())
    }

    async fn reclaim_orphans(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        // Single-flight: any `dispatched` row at boot is from a crashed run → back to `pending`.
        let n = conn
            .execute(
                "UPDATE stimulus SET status='pending', started_at=NULL WHERE status='dispatched'",
                [],
            )
            .map_err(db)?;
        Ok(n)
    }

    async fn set_payload(&self, id: &StimulusId, payload: serde_json::Value) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE stimulus SET payload=?1 WHERE id=?2",
            params![payload.to_string(), id.0],
        )
        .map_err(db)?;
        Ok(())
    }

    async fn find_coalescable(
        &self,
        type_: &StimulusType,
        dedup_key: &str,
    ) -> Result<Vec<Stimulus>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {COLS} FROM stimulus
                 WHERE status='pending' AND type=?1 AND dedup_key=?2
                 ORDER BY received_at ASC"
            ))
            .map_err(db)?;
        let raws = stmt
            .query_map(params![type_.0, dedup_key], read_raw)
            .map_err(db)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db)?;
        raws.into_iter().map(raw_to_stimulus).collect()
    }

    async fn depth(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM stimulus WHERE status='pending'",
                [],
                |r| r.get(0),
            )
            .map_err(db)?;
        Ok(n as usize)
    }

    async fn get_cursor(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT value FROM cursor WHERE key=?1", params![key], |r| r.get(0))
            .optional()
            .map_err(db)
    }

    async fn set_cursor(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO cursor(key,value) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )
        .map_err(db)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::stimulus::{Priority, TrustTier};
    use serde_json::json;

    fn mk(id: &str, prio: Priority, received_at: i64, type_: &str, dedup: Option<&str>) -> Stimulus {
        Stimulus {
            id: StimulusId(id.into()),
            source: "twitter-mentions".into(),
            type_: StimulusType(type_.into()),
            directive_tier: TrustTier::self_(),
            payload_tier: TrustTier::public(),
            payload: json!({"text": id}),
            provenance: None,
            received_at,
            dedup_key: dedup.map(|s| s.into()),
            priority: prio,
            status: StimulusStatus::Pending,
            directive_body: "duty".into(),
            entry: "perceive".into(),
        }
    }

    #[tokio::test]
    async fn pops_highest_priority_then_oldest() {
        let q = SqliteQueue::open_in_memory().unwrap();
        q.enqueue(mk("low", Priority::Low, 100, "mention", None)).await.unwrap();
        q.enqueue(mk("urgent", Priority::Urgent, 200, "mention", None)).await.unwrap();
        q.enqueue(mk("normal-old", Priority::Normal, 50, "mention", None)).await.unwrap();
        q.enqueue(mk("normal-new", Priority::Normal, 90, "mention", None)).await.unwrap();

        // Urgent first regardless of age.
        assert_eq!(q.next().await.unwrap().unwrap().id.0, "urgent");
        // Then the older of the two Normals (received_at tiebreak), before Low.
        assert_eq!(q.next().await.unwrap().unwrap().id.0, "normal-old");
        assert_eq!(q.next().await.unwrap().unwrap().id.0, "normal-new");
        assert_eq!(q.next().await.unwrap().unwrap().id.0, "low");
        assert!(q.next().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn next_marks_dispatched_and_depth_counts_pending() {
        let q = SqliteQueue::open_in_memory().unwrap();
        q.enqueue(mk("a", Priority::Normal, 1, "mention", None)).await.unwrap();
        q.enqueue(mk("b", Priority::Normal, 2, "mention", None)).await.unwrap();
        assert_eq!(q.depth().await.unwrap(), 2);
        let popped = q.next().await.unwrap().unwrap();
        assert_eq!(popped.status, StimulusStatus::Dispatched);
        assert_eq!(q.depth().await.unwrap(), 1); // dispatched no longer pending
    }

    #[tokio::test]
    async fn find_coalescable_matches_pending_same_type_and_key() {
        let q = SqliteQueue::open_in_memory().unwrap();
        q.enqueue(mk("m1", Priority::Low, 1, "mention", Some("thread-7"))).await.unwrap();
        q.enqueue(mk("m2", Priority::Low, 2, "mention", Some("thread-7"))).await.unwrap();
        q.enqueue(mk("other", Priority::Low, 3, "mention", Some("thread-9"))).await.unwrap();
        let hits = q.find_coalescable(&StimulusType::from("mention"), "thread-7").await.unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id.0, "m1"); // ordered by received_at
    }

    #[tokio::test]
    async fn set_payload_replaces_the_stored_json() {
        let q = SqliteQueue::open_in_memory().unwrap();
        q.enqueue(mk("p", Priority::Low, 1, "mention", None)).await.unwrap();
        q.set_payload(&StimulusId("p".into()), json!({"items": [1, 2, 3]})).await.unwrap();
        let got = q.find_coalescable(&StimulusType::from("mention"), "nope").await; // no key match
        assert!(got.unwrap().is_empty());
        // Pop it and confirm the payload round-tripped.
        let s = q.next().await.unwrap().unwrap();
        assert_eq!(s.payload, json!({"items": [1, 2, 3]}));
    }

    #[tokio::test]
    async fn reclaim_requeues_orphaned_dispatched_rows() {
        let q = SqliteQueue::open_in_memory().unwrap();
        q.enqueue(mk("a", Priority::Normal, 1, "mention", None)).await.unwrap();
        q.enqueue(mk("b", Priority::Normal, 2, "mention", None)).await.unwrap();
        // Two rows leased (→ dispatched), then a "crash" leaves them stuck.
        let a = q.next().await.unwrap().unwrap();
        let _b = q.next().await.unwrap().unwrap();
        assert_eq!(a.status, StimulusStatus::Dispatched);
        assert_eq!(q.depth().await.unwrap(), 0, "nothing pending mid-flight");

        // One reached a terminal state; the other is an orphan.
        q.update_status(&StimulusId("a".into()), StimulusStatus::Done).await.unwrap();
        let reclaimed = q.reclaim_orphans().await.unwrap();
        assert_eq!(reclaimed, 1, "only the still-dispatched orphan is requeued");
        assert_eq!(q.depth().await.unwrap(), 1, "the orphan is pending again");
        // The reclaimed row is `b` (Done `a` is terminal, never reconsidered).
        assert_eq!(q.next().await.unwrap().unwrap().id.0, "b");
    }

    #[tokio::test]
    async fn survives_reopen_persistence() {
        let dir = std::env::temp_dir().join(format!("dack-q-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("q.sqlite");
        {
            let q = SqliteQueue::open(&path).unwrap();
            q.enqueue(mk("persisted", Priority::High, 1, "mention", None)).await.unwrap();
            assert_eq!(q.depth().await.unwrap(), 1);
        } // drop closes the connection
        {
            let q = SqliteQueue::open(&path).unwrap();
            assert_eq!(q.depth().await.unwrap(), 1);
            assert_eq!(q.next().await.unwrap().unwrap().id.0, "persisted");
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
