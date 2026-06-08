//! The stimulus queue — **single-flight** (concurrency = 1; the duck is one mind,
//! architecture §3, PRD §5.6). Harness writer-of-record; the agent never sees it
//! (PRD §7.1). v1 backing store is embedded SQLite on the VPS (ephemeral — losing it
//! loses only the queue, not the soul, PRD §9.3).
//!
//! A hand-rolled priority queue over SQLite is fine at single-agent scale — single-
//! flight makes it trivial (PRD §9.2). SCAFFOLD: an in-memory [`InMemoryQueue`] makes
//! the loop runnable now; the SQLite impl lands in Phase 3.

use async_trait::async_trait;

use crate::error::Result;
use crate::model::stimulus::{Stimulus, StimulusId, StimulusStatus, StimulusType};

#[async_trait]
pub trait Queue: Send + Sync {
    async fn enqueue(&self, stimulus: Stimulus) -> Result<()>;

    /// Pop the highest-priority `pending` row and mark it `dispatched`. Single-flight:
    /// returns at most one, and the harness processes it to completion before the next.
    async fn next(&self) -> Result<Option<Stimulus>>;

    async fn update_status(&self, id: &StimulusId, status: StimulusStatus) -> Result<()>;

    /// Boot reconciliation (PRD §9.3): requeue rows stuck in `dispatched` — a crash mid-run
    /// orphans the in-flight row (`next` flipped it `dispatched`, nothing advanced it). v1
    /// effects are reversible (post/memory, never Settle), so **requeue is safe**: the duck
    /// reconsiders the stimulus rather than silently dropping it. Single-flight means there is
    /// at most one such row. Returns how many were reclaimed (logged at boot).
    async fn reclaim_orphans(&self) -> Result<usize>;

    /// Replace a row's payload — used by the bus to fold a `batch`-coalesced candidate
    /// into the pending accumulator row (PRD §5.6). Policy stays in the bus; the queue is
    /// a dumb store.
    async fn set_payload(&self, id: &StimulusId, payload: serde_json::Value) -> Result<()>;

    /// Rows eligible to coalesce with an incoming candidate (same type + dedup_key,
    /// still `pending`) — PRD §5.6 "coalesce".
    async fn find_coalescable(
        &self,
        type_: &StimulusType,
        dedup_key: &str,
    ) -> Result<Vec<Stimulus>>;

    /// Queue depth, for `dack status` (PRD §8.3).
    async fn depth(&self) -> Result<usize>;

    /// Read a cross-poll dedup **cursor** (watermark) by key — `None` until first set. The
    /// harness injects it into a polling sensor's env so it fetches only newer items (PRD §10.2).
    async fn get_cursor(&self, key: &str) -> Result<Option<String>>;

    /// Persist a cursor watermark (insert-or-replace). Called after a poll with the max seen
    /// value; single-flight makes the read-modify-write race-free.
    async fn set_cursor(&self, key: &str, value: &str) -> Result<()>;
}

mod memory_queue;
mod sqlite;
pub use memory_queue::InMemoryQueue;
pub use sqlite::SqliteQueue;
