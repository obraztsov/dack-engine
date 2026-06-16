//! The agent's I/O contract (PRD §6.2). Conceptually the agent has **no free-form
//! output channel** — every external effect is a skill (Twitter via skill, DAC via
//! skill+MCP, commits via gl-MCP). The agent's *return value* to the harness is this
//! small structured object: reasoning + whether a state transition is requested.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transition {
    /// `None` = terminate this cycle. Otherwise the chosen next state-prompt id (e.g.
    /// `twitter/feed_reply`).
    #[serde(default)]
    pub to_prompt: Option<String>,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub transition: Transition,
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
}
