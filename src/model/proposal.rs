//! The agent's I/O contract (PRD §6.2). Conceptually the agent has **no free-form
//! output channel** — every external effect is a skill (Twitter via skill, DAC via
//! skill+MCP, commits via gl-MCP). The agent's *return value* to the harness is this
//! small structured object: reasoning + whether a state transition is requested.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::state::ConsciousnessState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    Reply,
    Post,
    Research,
    Ignore,
    Noop,
}

/// The digested proposal Perceive hands forward — becomes the [`super::baton::Baton`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proposal {
    pub intent: Intent,
    /// Digested intent — NOT raw stimulus text.
    pub gist: String,
    #[serde(default)]
    pub refs: BTreeMap<String, String>,
}

/// A requested state transition. Whether it is *honored* is decided by the harness
/// against [`crate::state::allowed_transition`] — the agent proposes, the harness opens.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Transition {
    /// `None` = stay / terminate this cycle.
    #[serde(default)]
    pub to_state: Option<ConsciousnessState>,
    #[serde(default)]
    pub reason: String,
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
    pub transition: Transition,
}
