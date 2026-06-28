//! The agent's I/O contract (PRD §6.2). Conceptually the agent has **no free-form
//! output channel** — every external effect is a skill (Twitter via skill, DAC via
//! skill+MCP, commits via gl-MCP). The agent's *return value* to the harness is this
//! small structured object: reasoning + whether a state transition is requested.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::stimulus::Priority;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    Reply,
    Post,
    Research,
    /// Hand a real, longer job to a keyless sandboxed worker (Phase 10). Declared in Perceive to
    /// signal the intent; the actual [`SpawnRequest`] is honored only once the duck reaches Express.
    Delegate,
    Ignore,
    Noop,
    /// Catch-all for any intent label the model emits that we don't model explicitly. `intent` is
    /// **descriptive only** — control flow is driven by `transition.to_prompt`/`spawn`, never by
    /// `intent` — so an unrecognized label must degrade here, NEVER hard-error the cycle.
    #[serde(other)]
    Other,
}

/// The digested proposal Perceive hands forward — becomes the [`super::baton::Baton`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proposal {
    pub intent: Intent,
    /// Digested intent — NOT raw stimulus text.
    pub gist: String,
    /// The duck's own soft reference annotations. The harness-critical refs (`source_tweet_id`,
    /// `source_author`) are injected DETERMINISTICALLY into the Baton from the stimulus payload, not
    /// from here — so this is non-load-bearing and accepts whatever shape the model emits (object,
    /// array, scalar, or null), normalized to a string map. Never hard-errors the cycle.
    #[serde(default, deserialize_with = "de_refs")]
    pub refs: BTreeMap<String, String>,
}

/// Lenient `refs` deserializer — a weaker model emits this field inconsistently (a `["a","b"]`
/// array, a `{"k":"v"}` object, a bare string, or `null`). All normalize to `BTreeMap<String,
/// String>`; arrays/scalars get index keys. Non-string values are stringified. This keeps a cosmetic
/// shape mismatch from failing the whole proposal parse (which would abort the consciousness cycle).
fn de_refs<'de, D>(d: D) -> Result<BTreeMap<String, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde_json::Value;
    let val_to_string = |v: &Value| -> String {
        match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    };
    Ok(match Value::deserialize(d)? {
        Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), val_to_string(v))).collect(),
        Value::Array(items) => {
            items.iter().enumerate().map(|(i, v)| (i.to_string(), val_to_string(v))).collect()
        }
        Value::Null => BTreeMap::new(),
        other => BTreeMap::from([("0".to_string(), val_to_string(&other))]),
    })
}

/// A requested state transition (MCP2-B). The agent names the **next state-prompt id** it chooses
/// — exactly one of the current prompt's declared `transitions` (or `None` to terminate). Whether
/// it is honored is decided by the harness: the id must be in the allowed set, resolve to a real
/// `prompts/<id>.md`, sit within the route ceiling, and pass [`crate::state::allowed_transition`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Transition {
    /// `None` = terminate this cycle. Otherwise the chosen next state-prompt id (e.g.
    /// `twitter/feed_reply`).
    #[serde(default)]
    pub to_prompt: Option<String>,
    #[serde(default)]
    pub reason: String,
}

/// One **fan-out branch** the model proposes from a state (Phase 1). A single cycle may emit
/// SEVERAL — each its own digested gist + destination state-prompt, processed as an independent
/// branch with its own taint trajectory (the in-wake worklist). Supersedes the single [`Transition`]
/// (still accepted and normalized to a one-element fan-out by [`AgentOutput::fan_out`]).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BatonIntent {
    /// The next state-prompt id this branch continues to — must be one of the EMITTING prompt's
    /// declared `transitions:` (and within the branch's trust ceiling; the harness re-checks both).
    pub to_prompt: String,
    /// The digested intent for THIS branch — the agent's OWN product (the firebreak), never raw
    /// stimulus text. Empty ⇒ the harness falls back to the proposal gist / thought (the legacy
    /// single-baton behaviour), so an old-shape output keeps working.
    #[serde(default)]
    pub gist: String,
    /// Proposed scheduling priority for this branch. Harness-CLAMPED (never trusted to raise above
    /// the origin) — `None` ⇒ inherit the cycle's. Honored from Phase 3; carried here from Phase 1.
    #[serde(default)]
    pub priority: Option<Priority>,
    /// The message this branch REPLIES TO — the id the model copies from a message it saw in the
    /// batch (`payload.items`), e.g. a telegram `message_id`. The harness VALIDATES it against the
    /// batch it holds (the firebreak): an id not in `items` is ignored (the reply falls back to the
    /// latest/top-level, never an arbitrary target). `None` = reply to the coalesced top-level (the
    /// latest message — legacy). Platform-agnostic; the identifier FIELD is the emitting prompt's
    /// `reply_key` (default `message_id`→`id`).
    #[serde(default)]
    pub reply_to: Option<String>,
    /// Extra context-recall tags for this branch (beyond the auto conversation key the harness adds when
    /// the prompt sets `tag_key`) — e.g. a topic. Carried onto the runlog entry so a tagged view can
    /// recall it later. Usually empty; the model rarely needs to set it. `#[serde(default)]` = none.
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub reason: String,
}

/// A request to delegate a job to a **keyless sandboxed worker** (Phase 10). The agent names an
/// `agents/<agent>.md` def + a one-shot `brief`; the harness launches the worker ASYNCHRONOUSLY
/// (its own worker-spec sandbox, no soul/post/settle), and its summary returns later as an UNTRUSTED
/// `worker_completion` stimulus (the return-firebreak). Honored only from an act state (Express) —
/// the duck delegates, it does not become the worker. NOT the SDK `Task` tool (that's worker-only).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnRequest {
    /// The `agents/<agent>.md` definition to run (must resolve in the soul repo).
    pub agent: String,
    /// The task brief handed to the worker (untrusted-on-return; the duck decides what to publish).
    pub brief: String,
}

/// The full agent return value (PRD §6.2).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentOutput {
    /// Internal reasoning — **logged, never published** (Eliza-style "thought").
    /// Rides the Baton for continuity but is NOT a safety boundary (PRD §6.4).
    pub thought: String,
    /// Optional line to append to memory. Honored only in Express/Reflect; a write
    /// tool call in Perceive is denied by construction (PRD §4.1, §6.2).
    #[serde(default)]
    pub memory_append: Option<String>,
    #[serde(default)]
    pub proposal: Option<Proposal>,
    /// Optional worker delegation (Phase 10). Honored only from Express; launched async, returns as
    /// an untrusted `worker_completion` stimulus. `None` (the common case) = no delegation.
    #[serde(default)]
    pub spawn: Option<SpawnRequest>,
    /// Legacy single transition (still accepted). `fan_out()` folds it into `batons`.
    #[serde(default)]
    pub transition: Transition,
    /// **Fan-out** (Phase 1): the branches this cycle wants to take. Several = do several things at
    /// once, each its own gist + destination, each an independent branch. Empty = terminate. Wins
    /// over the legacy `transition` when present.
    #[serde(default)]
    pub batons: Vec<BatonIntent>,
}

impl AgentOutput {
    /// The branches to fan out to, normalizing the legacy single `transition` into a one-element
    /// list: `batons` when present; else a `transition.to_prompt` becomes one branch; else empty
    /// (terminate). A synthesized branch carries an empty `gist` so the harness falls back to the
    /// proposal/thought (preserving the exact legacy single-baton payload).
    pub fn fan_out(&self) -> Vec<BatonIntent> {
        if !self.batons.is_empty() {
            return self.batons.clone();
        }
        match &self.transition.to_prompt {
            Some(id) => vec![BatonIntent {
                to_prompt: id.clone(),
                reason: self.transition.reason.clone(),
                ..Default::default()
            }],
            None => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A weaker model emits `intent`/`refs` in shapes the strict schema would reject. None of these
    /// may abort the cycle: an unknown intent degrades to `Other`, and `refs` accepts any JSON shape.
    #[test]
    fn proposal_parse_tolerates_model_shape_drift() {
        // refs as an ARRAY (the mimo shape that broke the live worker demo), unknown intent label.
        let p: Proposal = serde_json::from_str(
            r#"{"intent":"build","gist":"g","refs":["standing-directive: x","ref two"]}"#,
        )
        .expect("array refs + unknown intent must parse");
        assert_eq!(p.intent, Intent::Other);
        assert_eq!(p.refs.get("0").map(String::as_str), Some("standing-directive: x"));
        assert_eq!(p.refs.get("1").map(String::as_str), Some("ref two"));

        // refs as an OBJECT still works; a known intent still maps.
        let p: Proposal =
            serde_json::from_str(r#"{"intent":"delegate","gist":"g","refs":{"k":"v"}}"#).unwrap();
        assert_eq!(p.intent, Intent::Delegate);
        assert_eq!(p.refs.get("k").map(String::as_str), Some("v"));

        // refs null / omitted → empty (no error).
        let p: Proposal = serde_json::from_str(r#"{"intent":"noop","gist":"g","refs":null}"#).unwrap();
        assert!(p.refs.is_empty());
        let p: Proposal = serde_json::from_str(r#"{"intent":"noop","gist":"g"}"#).unwrap();
        assert!(p.refs.is_empty());
    }

    /// `fan_out()` normalizes both shapes: the new `batons` list wins; a legacy single `transition`
    /// folds to one branch; nothing ⇒ terminate. This is the back-compat contract for Phase 1.
    #[test]
    fn fan_out_normalizes_legacy_and_multi() {
        // New shape: an explicit batons list is used verbatim (the fan-out).
        let multi: AgentOutput = serde_json::from_str(
            r#"{"thought":"t","batons":[
                 {"to_prompt":"telegram/express","gist":"reply","reply_to":"42"},
                 {"to_prompt":"settle","gist":"trade","priority":"high"}]}"#,
        )
        .unwrap();
        let b = multi.fan_out();
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].to_prompt, "telegram/express");
        assert_eq!(b[0].reply_to.as_deref(), Some("42"), "reply target parses");
        assert_eq!(b[1].to_prompt, "settle");
        assert!(b[1].reply_to.is_none());
        assert!(matches!(b[1].priority, Some(crate::model::stimulus::Priority::High)));

        // Legacy shape: a single transition folds to exactly one branch (empty gist → harness
        // falls back to proposal/thought when building the baton).
        let legacy: AgentOutput = serde_json::from_str(
            r#"{"thought":"t","proposal":{"intent":"reply","gist":"g"},
                "transition":{"to_prompt":"express","reason":"r"}}"#,
        )
        .unwrap();
        let b = legacy.fan_out();
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].to_prompt, "express");
        assert!(b[0].gist.is_empty(), "synthesized branch defers gist to the harness");
        assert!(b[0].reply_to.is_none(), "legacy transition has no reply target");

        // Terminate: no batons, null transition ⇒ no branches.
        let term: AgentOutput =
            serde_json::from_str(r#"{"thought":"t","transition":{"to_prompt":null}}"#).unwrap();
        assert!(term.fan_out().is_empty());
        // Default output also terminates (the ScriptedRuntime's terminal value).
        assert!(AgentOutput::default().fan_out().is_empty());
    }
}
