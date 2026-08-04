//! `ActiveConversations` — the in-memory registry of conversations a cycle is CURRENTLY processing.
//!
//! It mirrors the consciousness loop's in-flight `busy_keys` (Axis-1 per-thread serialization), but is
//! reachable from OUTSIDE the loop: one handle is cloned into the [`Harness`](crate::harness::Harness)
//! run loop (which marks a conversation active for the whole dispatch — dequeue → reply-sent) and another
//! into the webhook server (which exposes it over `GET /active-conversations`). The Telegram ingress polls
//! that endpoint every few seconds to drive a "typing…" indicator that reflects REAL processing: it only
//! appears once a cycle actually starts (AFTER the coalesce window + queue wait), never on mere receipt.
//!
//! It is deliberately SEPARATE from the loop's `busy_keys` (a concurrency-gate primitive) so external
//! observability doesn't couple to the scheduler, and so each entry can carry metadata the gate doesn't
//! need. Keyed by the stimulus `dedup_key` = the conversation identity (a Telegram chat_id, a twitter
//! conversation id, a cron key). Each entry carries the stimulus `type` (`telegram_message`, …) and
//! `source` (the duty id) so a poller can filter to its own channel — a twitter conversation id is a big
//! positive number that would otherwise masquerade as a telegram chat_id. Cheap: a plain `Mutex<HashMap>`
//! cloned under the lock on read (a handful of entries at `max_concurrent_cycles`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;

/// A shared, cheap-to-clone handle to the set of conversations being processed right now.
#[derive(Clone, Default)]
pub struct ActiveConversations {
    inner: Arc<Mutex<HashMap<String, Entry>>>,
}

#[derive(Clone)]
struct Entry {
    type_: String,
    source: String,
    started: Instant,
}

/// One active conversation, rendered for the `GET /active-conversations` API.
#[derive(Debug, Clone, Serialize)]
pub struct ActiveConversation {
    /// The conversation key = the stimulus `dedup_key` (a Telegram chat_id when `type == telegram_message`).
    pub key: String,
    /// The stimulus type (e.g. `telegram_message`) — the stable channel discriminator a poller filters on.
    #[serde(rename = "type")]
    pub type_: String,
    /// The duty id that produced this cycle (e.g. `telegram-op`) — for observability.
    pub source: String,
    /// Seconds this cycle has been in flight.
    pub since_secs: u64,
}

impl ActiveConversations {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mark a conversation as actively processing. Idempotent — a re-mark keeps the original start
    /// instant (so `since_secs` measures the true beginning). Called at cycle dispatch, right next to the
    /// loop's `busy_keys` insert.
    pub fn begin(&self, key: &str, type_: &str, source: &str) {
        self.inner
            .lock()
            .unwrap()
            .entry(key.to_string())
            .or_insert_with(|| Entry {
                type_: type_.to_string(),
                source: source.to_string(),
                started: Instant::now(),
            });
    }

    /// Clear a conversation — its cycle finished (reply sent / decided silent / errored). Called right
    /// next to the loop's `busy_keys` remove.
    pub fn end(&self, key: &str) {
        self.inner.lock().unwrap().remove(key);
    }

    /// A cheap snapshot of everything in flight, for the API.
    pub fn snapshot(&self) -> Vec<ActiveConversation> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .map(|(key, e)| ActiveConversation {
                key: key.clone(),
                type_: e.type_.clone(),
                source: e.source.clone(),
                since_secs: e.started.elapsed().as_secs(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn begin_end_snapshot_lifecycle() {
        let a = ActiveConversations::new();
        assert!(a.snapshot().is_empty());

        a.begin("555", "telegram_message", "telegram-op");
        a.begin("1780000000000000000", "mention", "twitter-mentions");
        let snap = a.snapshot();
        assert_eq!(snap.len(), 2);
        let tg = snap.iter().find(|c| c.key == "555").expect("chat 555 present");
        assert_eq!(tg.type_, "telegram_message");
        assert_eq!(tg.source, "telegram-op");

        // idempotent: a re-begin does not add a second entry
        a.begin("555", "telegram_message", "telegram-op");
        assert_eq!(a.snapshot().len(), 2);

        a.end("555");
        let snap = a.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].key, "1780000000000000000");

        a.end("missing"); // ending an absent key is a no-op, never panics
        assert_eq!(a.snapshot().len(), 1);
    }
}
