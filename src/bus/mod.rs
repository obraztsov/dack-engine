//! The Stimulus Bus (architecture §3 layer 2, PRD §5.6) — **dumb, central, no LLM.**
//! Intelligence is quarantined in the consciousness layer; a reasoning collector here
//! would be an unguarded injection surface upstream of the firebreak (architecture §1).
//!
//! Pipeline: normalize → classify → prioritize → coalesce → **serialize (single-flight)**
//! → enqueue. The agent influences priority and authors its own duty-stimuli (in
//! Reflect); it never edits the routing table or assigns tiers (PRD §5.6).

use std::sync::Arc;

use crate::config::{CoalesceMode, DackConfig};
use crate::error::Result;
use crate::model::stimulus::{
    Priority, Stimulus, StimulusId, StimulusStatus, StimulusType, TrustTier,
};
use crate::queue::Queue;
use crate::sensor::SensorCandidate;
use crate::stimuli::StimulusDef;

pub struct Bus {
    config: Arc<DackConfig>,
    queue: Arc<dyn Queue>,
}

impl Bus {
    pub fn new(config: Arc<DackConfig>, queue: Arc<dyn Queue>) -> Self {
        Self { config, queue }
    }

    /// Normalize sensor candidates from one duty firing into `Stimulus` rows and enqueue
    /// them (PRD §5.5 steps 4–5), applying the duty's coalescing policy. `received_at` is
    /// supplied by the caller (the harness stamps wall-clock time) so the bus stays
    /// deterministic and testable. Returns the ids of *newly enqueued* rows (a candidate
    /// folded into an existing batch row mints no new wake).
    pub async fn ingest(
        &self,
        def: &StimulusDef,
        candidates: Vec<SensorCandidate>,
        received_at: i64,
    ) -> Result<Vec<StimulusId>> {
        let fm = &def.frontmatter;
        let mut enqueued = Vec::new();

        for (i, c) in candidates.into_iter().enumerate() {
            let SensorCandidate {
                type_,
                payload,
                dedup_key,
                payload_tier: cand_tier,
            } = c;
            // The source assigns the tier; a sensor may only *lower* it. A candidate claiming a
            // tier above the duty's `default_payload_tier` is clamped down — closing a trust-tier
            // escalation primitive (arbitrary Reflect-authored sensor code, PRD §5.7).
            let payload_tier = cand_tier
                .map(|c| c.min_trust(fm.emits.default_payload_tier))
                .unwrap_or(fm.emits.default_payload_tier);
            let priority = self.classify_priority(payload_tier, &type_, fm.priority);
            // Entry **state-prompt** (MCP2-B): the duty's own frontmatter `entry:` (a state-prompt
            // id like `twitter/perceive_mention`). The path the chain then walks is soul-owned; the
            // operator route only supplies the *ceiling* (read at dispatch), not the entry.
            let entry = fm.entry.clone();

            // Coalescing (PRD §5.6). `None` → always a fresh wake; `Latest` → supersede
            // prior pending rows for this key and enqueue the newest; `Batch` → fold the
            // payload into the oldest pending accumulator row within the window (no new wake).
            let mut folded = false;
            if let (Some(policy), Some(key)) = (&fm.coalesce, dedup_key.as_deref()) {
                match policy.mode {
                    CoalesceMode::None => {}
                    CoalesceMode::Latest => {
                        for s in self
                            .within_window(&type_, key, received_at, policy.window_sec)
                            .await?
                        {
                            self.queue
                                .update_status(&s.id, StimulusStatus::Coalesced)
                                .await?;
                        }
                    }
                    CoalesceMode::Batch => {
                        if let Some(acc) = self
                            .within_window(&type_, key, received_at, policy.window_sec)
                            .await?
                            .into_iter()
                            .next()
                        {
                            // Fold into the accumulator; keep its received_at (FIFO fairness)
                            // so a hot thread can't starve older pending stimuli.
                            let merged = merge_batch(acc.payload, &payload);
                            self.queue.set_payload(&acc.id, merged).await?;
                            folded = true;
                        }
                    }
                }
            }

            if folded {
                continue;
            }

            let id = StimulusId(format!("{}-{}-{}", fm.id, received_at, i));
            self.queue
                .enqueue(Stimulus {
                    id: id.clone(),
                    source: fm.id.clone(),
                    type_,
                    directive_tier: fm.directive_tier,
                    payload_tier,
                    payload,
                    provenance: None,
                    received_at,
                    dedup_key,
                    priority,
                    status: StimulusStatus::Pending,
                    directive_body: def.directive_body.clone(),
                    entry,
                })
                .await?;
            enqueued.push(id);
        }
        Ok(enqueued)
    }

    /// Pending rows that can coalesce with an incoming candidate: same `(type, dedup_key)`,
    /// still within `window_sec` of `now` (unbounded when `None`), oldest first (so the
    /// first is the batch accumulator).
    async fn within_window(
        &self,
        type_: &StimulusType,
        key: &str,
        now: i64,
        window_sec: Option<u64>,
    ) -> Result<Vec<Stimulus>> {
        let mut rows = self.queue.find_coalescable(type_, key).await?;
        if let Some(w) = window_sec {
            let w = w as i64;
            rows.retain(|s| now - s.received_at <= w);
        }
        rows.sort_by_key(|s| s.received_at);
        Ok(rows)
    }

    /// Priority from the routing table, falling back to the duty's own hint, then Low.
    /// The routing table is operator config; the agent's authored priority is only a
    /// hint (PRD §5.6).
    fn classify_priority(
        &self,
        tier: TrustTier,
        type_: &StimulusType,
        duty_hint: Option<Priority>,
    ) -> Priority {
        self.config
            .lookup_route(tier, type_)
            .and_then(|r| r.priority)
            .or(duty_hint)
            .unwrap_or(Priority::Low)
    }
}

/// Fold a new payload into a batch accumulator. Shape: `{"_coalesced": true, "items":[…]}`.
/// The first fold wraps the existing single payload; subsequent folds push onto `items`.
/// Context assembly (Phase 5) renders a coalesced row as "N things since last wake".
fn merge_batch(existing: serde_json::Value, new: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match existing {
        Value::Object(mut m) if m.get("_coalesced") == Some(&Value::Bool(true)) => {
            if let Some(Value::Array(items)) = m.get_mut("items") {
                items.push(new.clone());
            }
            Value::Object(m)
        }
        other => serde_json::json!({ "_coalesced": true, "items": [other, new] }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::InMemoryQueue;
    use crate::sensor::SensorCandidate;
    use serde_json::json;

    fn bus() -> Bus {
        let config = Arc::new(DackConfig::from_yaml("operator_did: \"did:key:zOp\"").unwrap());
        Bus::new(config, Arc::new(InMemoryQueue::new()))
    }

    /// A duty whose frontmatter carries the given coalesce policy line (or none).
    fn duty(coalesce_line: &str) -> StimulusDef {
        let text = format!(
            "---\nid: mentions\ntrigger: {{ type: cron, schedule: \"0 * * * *\" }}\n\
             directive_tier: self\nemits:\n  type: mention\n  default_payload_tier: public\n\
             {coalesce_line}entry: perceive\n---\nReply-guy duty.\n"
        );
        StimulusDef::parse(&text, "stimuli/mentions/STIMULUS.md").unwrap()
    }

    fn cand(text: &str, key: &str) -> SensorCandidate {
        SensorCandidate {
            type_: StimulusType::from("mention"),
            payload: json!({ "text": text }),
            dedup_key: Some(key.into()),
            payload_tier: None,
        }
    }

    #[tokio::test]
    async fn none_keeps_every_candidate() {
        let b = bus();
        let def = duty("coalesce: { mode: none }\n");
        let ids = b
            .ingest(&def, vec![cand("a", "t1"), cand("b", "t1"), cand("c", "t1")], 1000)
            .await
            .unwrap();
        assert_eq!(ids.len(), 3);
        assert_eq!(b.queue.depth().await.unwrap(), 3);
    }

    #[tokio::test]
    async fn latest_supersedes_prior_pending() {
        let b = bus();
        let def = duty("coalesce: { mode: latest, dedup_key: thread_id }\n");
        b.ingest(&def, vec![cand("old", "t1")], 1000).await.unwrap();
        b.ingest(&def, vec![cand("new", "t1")], 1001).await.unwrap();
        // Only the newest stays pending; the older is coalesced away.
        assert_eq!(b.queue.depth().await.unwrap(), 1);
        let popped = b.queue.next().await.unwrap().unwrap();
        assert_eq!(popped.payload, json!({ "text": "new" }));
    }

    #[tokio::test]
    async fn batch_folds_many_into_one_wake() {
        let b = bus();
        let def = duty("coalesce: { mode: batch, window_sec: 600, dedup_key: thread_id }\n");
        // 50 mentions → 1 wake (the PRD's worked example, in miniature).
        let ids = b
            .ingest(
                &def,
                vec![cand("m1", "t1"), cand("m2", "t1"), cand("m3", "t1")],
                1000,
            )
            .await
            .unwrap();
        assert_eq!(ids.len(), 1, "only the first candidate mints a wake");
        assert_eq!(b.queue.depth().await.unwrap(), 1);
        let row = b.queue.next().await.unwrap().unwrap();
        let items = row.payload.get("items").and_then(|v| v.as_array()).unwrap();
        assert_eq!(items.len(), 3, "all three folded into the accumulator");
    }

    #[tokio::test]
    async fn batch_outside_window_starts_a_new_row() {
        let b = bus();
        let def = duty("coalesce: { mode: batch, window_sec: 600, dedup_key: thread_id }\n");
        b.ingest(&def, vec![cand("early", "t1")], 1000).await.unwrap();
        // 700s later: outside the 600s window → a fresh accumulator, not a fold.
        b.ingest(&def, vec![cand("late", "t1")], 1700).await.unwrap();
        assert_eq!(b.queue.depth().await.unwrap(), 2);
    }

    #[tokio::test]
    async fn sensor_cannot_raise_tier_above_duty_default() {
        let b = bus();
        let def = duty("coalesce: { mode: none }\n"); // default_payload_tier: public
        // A sensor lies, claiming operator_signed to try to escalate its row's trust.
        let candidate = SensorCandidate {
            type_: StimulusType::from("mention"),
            payload: json!({ "text": "trust me" }),
            dedup_key: None,
            payload_tier: Some(TrustTier::OperatorSigned),
        };
        b.ingest(&def, vec![candidate], 1000).await.unwrap();
        let row = b.queue.next().await.unwrap().unwrap();
        // Clamped down to the duty's declared ceiling — the lie is ignored.
        assert_eq!(row.payload_tier, TrustTier::Public);
    }

    #[tokio::test]
    async fn different_keys_do_not_coalesce() {
        let b = bus();
        let def = duty("coalesce: { mode: batch, window_sec: 600, dedup_key: thread_id }\n");
        b.ingest(&def, vec![cand("a", "t1"), cand("b", "t2")], 1000).await.unwrap();
        assert_eq!(b.queue.depth().await.unwrap(), 2);
    }
}
