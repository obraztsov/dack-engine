//! The domain model — the *spine* of the harness (architecture §3.6, PRD §5–§6).
//!
//! Four first-class data objects, each owned by a different writer-of-record
//! (PRD §7.1):
//!   - [`stimulus::Stimulus`] — inert event data, harness-owned, never agent-written.
//!   - [`baton::Baton`]       — the in-flight handoff between consciousness states;
//!                              the firebreak made structural (PRD §6.4).
//!   - [`proposal::AgentOutput`] — the agent's ONLY return channel (PRD §6.2).
//!   - [`runlog::RunLogEntry`]   — the harness-authored record of what happened (PRD §7.5).

pub mod baton;
pub mod proposal;
pub mod runlog;
pub mod stimulus;
