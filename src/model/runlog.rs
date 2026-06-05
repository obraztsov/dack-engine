//! The RunLog entry (PRD §7.5). **Harness-authored — the agent can never write it.**
//! Rationale (keep this; an implementer will be tempted to let the agent log itself):
//! if the agent could write its own runlog, a compromised agent could erase the
//! evidence of its own compromise. The record must be authored by the layer that is
//! not under attack.
//!
//! Append-only, one file per day (`runlogs/YYYY-MM-DD.md`). Errors are entries tagged
//! `error` — there is no separate ErrorLog store; Reflect reviews the day's runlogs
//! (including errors) and decides what to learn (PRD §7.5).

use serde::{Deserialize, Serialize};

use super::baton::Baton;
use super::proposal::AgentOutput;
use super::stimulus::StimulusId;
use crate::state::ConsciousnessState;

/// One `action_required` decision, recorded so an injection path is visible post-hoc
/// and becomes a lesson (PRD §7.5).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRecord {
    pub tool: String,
    /// "allow" | "deny: <reason>".
    pub decision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "outcome", content = "detail")]
pub enum Outcome {
    Ok,
    /// Errors are RunLog entries tagged `error` (PRD §7.5) — not a separate store.
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunLogEntry {
    /// Anchor for `runlog_ref`, e.g. "run-0412".
    pub run_id: String,
    pub stimulus_id: StimulusId,
    pub state: ConsciousnessState,
    /// A summary of the assembled invocation context (PRD §6.1).
    pub context_summary: String,
    /// The input→proposal (Baton) mapping, so an injection path is visible post-hoc.
    #[serde(default)]
    pub baton: Option<Baton>,
    /// Raw stimulus, stored in a **clearly-delimited-untrusted** block — this is what
    /// `runlog_ref` points at (PRD §6.4).
    pub raw_stimulus: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCallRecord>,
    #[serde(default)]
    pub output: Option<AgentOutput>,
    pub outcome: Outcome,
    pub timestamp: i64,
}
