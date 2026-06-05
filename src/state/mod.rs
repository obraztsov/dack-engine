//! Consciousness states — the security model, hardcoded (PRD §4, architecture §2).
//!
//! A consciousness state = an OpenClaude invocation with a fixed
//! **(system prompt + allowed-tool set + model)** triple plus a set of writable dirs.
//! The harness owns these triples; **the agent cannot widen them**. States are
//! hardcoded *because they are the security model*; only the *routing between them*
//! is operator config (the product-iteration surface).
//!
//! The cut is by **reversibility**, not by "does it write memory":
//!   - Perceive  — read-only, can't act (digests untrusted input → a typed proposal)
//!   - Express   — reversible writes (post/reply + memory-append)
//!   - Settle    — irreversible (EVM tx / vote) — THE wall; unreachable in v1
//!   - Reflect   — modifies soul/skills/stimuli/prompts; harness-entered & -exited only

use serde::{Deserialize, Serialize};

use crate::model::stimulus::TrustTier;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConsciousnessState {
    Perceive,
    Express,
    Settle,
    Reflect,
}

/// Per-state model routing — the primary inference-cost lever (PRD §4, §9.4).
/// Maps onto OpenClaude `agentRouting`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelTier {
    /// MiMo / Ollama-local — cheap/quiet runs (Perceive).
    CheapLocal,
    /// Mixed local+frontier (Express).
    Mixed,
    /// Frontier model — hard runs (Settle, Reflect).
    Frontier,
}

/// Tool *classes* the `action_required` responder (PRD §6.3) gates on. These are
/// coarse capability buckets, not the full OpenClaude tool list — the responder maps
/// a concrete tool call to its class, then checks class membership for the state.
/// Capability buckets the `action_required` responder gates on. Grounded to
/// OpenClaude's *actual* tool surface (audited 0.15.0): the responder receives a raw
/// `(tool_name, input)` and maps it to one of these via [`crate::runtime::classify`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolClass {
    /// Pure reads — FileRead, Grep, Glob, LSP, WebFetch/WebSearch (read), MCP resource
    /// reads, ToolSearch, Task{Get,List,Output}. Safe in every state.
    Read,
    /// File write/edit — the single OpenClaude Write/Edit/NotebookEdit tool. **The path,
    /// not the tool, decides memory-vs-soul**: gated by `writable_dirs` (memory/ in
    /// Express/Settle; soul dirs in Reflect). One class; the per-path gate does the rest.
    FileWrite,
    /// Reversible external effect — a *capability MCP tool* (e.g. `mcp__twitter__post`).
    /// Capabilities are MCP tools, NOT bash skill-scripts, precisely so they have clean
    /// gateable names (see [`Shell`](ToolClass::Shell) and VERIFICATION.md).
    Post,
    /// Irreversible authority — a *configured settle MCP tool* (e.g. `mcp__bankr__send`,
    /// `mcp__dac__vote`). Subject additionally to `allow_settle` (PRD §7.6).
    SettleTx,
    /// Arbitrary execution — Bash / PowerShell / REPL. **Denied in every v1 state.** Raw
    /// shell bypasses `writable_dirs` path-gating (a bash `>` can write soul dirs and
    /// defeat the Reflect-only self-modification invariant), so it is never in scope; real
    /// capabilities are exposed as MCP tools instead.
    Shell,
    /// Anything else — Agent, Skill, misc MCP, unknown tools. **Default-deny** unless a
    /// state explicitly scopes it. Unknown ⇒ denied (fail-closed).
    Other,
}

/// The fixed capability scope for a state. The set is closed at compile time; the
/// agent has no path to extend it (PRD §4).
#[derive(Debug, Clone)]
pub struct ToolScope {
    pub allowed: Vec<ToolClass>,
}

impl ToolScope {
    pub fn allows(&self, class: ToolClass) -> bool {
        self.allowed.contains(&class)
    }
}

/// The full (prompt + tools + model + writable dirs) spec for a state — the §4 table
/// as data. `writable_dirs` is the write-gating from §4.1: a prefix allow-list the
/// responder checks for any file-write target. `runlogs/` is in NO state's list —
/// the harness authors the record (PRD §4.1, §7.5).
#[derive(Debug, Clone)]
pub struct StateSpec {
    pub state: ConsciousnessState,
    /// Path within the soul repo, e.g. "prompts/perceive.md".
    pub prompt_path: &'static str,
    pub model: ModelTier,
    pub tool_scope: ToolScope,
    /// Repo path prefixes this state may write. Empty = read-only.
    pub writable_dirs: Vec<&'static str>,
}

/// The §4 / §4.1 table, as code. This is the single source of truth for write-gating;
/// the responder consults it and is never trusted to the agent.
pub fn default_spec(state: ConsciousnessState) -> StateSpec {
    use ConsciousnessState::*;
    use ToolClass::*;
    match state {
        Perceive => StateSpec {
            state,
            prompt_path: "prompts/perceive.md",
            model: ModelTier::CheapLocal,
            // Read-only: holds NO write tools at all, so raw-stimulus processing
            // cannot mutate state (PRD §4.1).
            tool_scope: ToolScope { allowed: vec![Read] },
            writable_dirs: vec![],
        },
        Express => StateSpec {
            state,
            prompt_path: "prompts/express.md",
            model: ModelTier::Mixed,
            // FileWrite is gated to memory/ by writable_dirs; Post is the capability MCP
            // tool. No Shell — bash would bypass the path gate.
            tool_scope: ToolScope {
                allowed: vec![Read, FileWrite, Post],
            },
            writable_dirs: vec!["memory/"],
        },
        Settle => StateSpec {
            state,
            prompt_path: "prompts/settle.md",
            model: ModelTier::Frontier,
            tool_scope: ToolScope {
                allowed: vec![Read, FileWrite, SettleTx],
            },
            // Writes memory like Express; the irreversible part is the SettleTx class,
            // gated additionally by `allow_settle` (PRD §7.6). Unreachable in v1.
            writable_dirs: vec!["memory/"],
        },
        Reflect => StateSpec {
            state,
            prompt_path: "prompts/reflect.md",
            model: ModelTier::Frontier,
            // The ONLY state whose writable_dirs include the soul dirs — same FileWrite
            // class as Express, but a wider path allow-list (PRD §4.1).
            tool_scope: ToolScope {
                allowed: vec![Read, FileWrite],
            },
            writable_dirs: vec!["skills/", "stimuli/", "prompts/", "SOUL.md", "memory/"],
        },
    }
}

/// State-transition rules (PRD §4.2). Encodes three invariants:
///   1. Perceive may open Express or Settle (via the Baton). Perceive proposes; the
///      harness opens the next state.
///   2. **Reflect is harness-entered only** — no state transitions *into* Reflect.
///      The agent cannot choose to reflect; an injected agent therefore cannot trigger
///      an immediate reflection to rewrite its own skills mid-attack. Self-modification
///      is real but rate-limited by the harness clock.
///   3. **Reflect is harness-exited only** — Reflect transitions into no other state.
///      It influences the future only indirectly, by writing `memory/` and `stimuli/`.
pub fn allowed_transition(from: ConsciousnessState, to: ConsciousnessState) -> bool {
    use ConsciousnessState::*;
    // Nothing may transition *into* Reflect (invariant 2).
    if to == Reflect {
        return false;
    }
    // Reflect transitions into nothing (invariant 3).
    if from == Reflect {
        return false;
    }
    matches!((from, to), (Perceive, Express) | (Perceive, Settle))
}

/// Max consciousness state a stimulus of a given tier may route toward (PRD §5.7).
/// This is the deterministic edge rule that generalizes the settlement predicate:
/// "a stimulus of sufficient provenance exists" is the precondition the dumb bus
/// checks before unlocking a dangerous state transition.
pub fn max_reachable_state(tier: TrustTier) -> ConsciousnessState {
    match tier {
        // (settle, when wired) — v1 has no routing edge to Settle regardless.
        TrustTier::OperatorSigned => ConsciousnessState::Settle,
        // self can author duties and reach Reflect via the harness clock (not directly).
        TrustTier::SelfTier => ConsciousnessState::Reflect,
        TrustTier::AuthedPeer => ConsciousnessState::Express,
        // A tweet / random webhook: Perceive only, always delimited untrusted.
        TrustTier::Public => ConsciousnessState::Perceive,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ConsciousnessState::*;

    #[test]
    fn perceive_is_read_only() {
        let spec = default_spec(Perceive);
        assert!(spec.tool_scope.allows(ToolClass::Read));
        // A file-write in Perceive is impossible by construction (PRD §4.1).
        assert!(!spec.tool_scope.allows(ToolClass::FileWrite));
        assert!(!spec.tool_scope.allows(ToolClass::Post));
        // Bash is never in scope anywhere — it would bypass path-gating.
        assert!(!spec.tool_scope.allows(ToolClass::Shell));
        assert!(spec.writable_dirs.is_empty());
    }

    #[test]
    fn only_reflect_writes_soul_dirs() {
        // Soul-write is now path-gated FileWrite: the class is shared, the PATH allow-list
        // is what differs — only Reflect lists the soul dirs.
        for dir in ["skills/", "stimuli/", "prompts/", "SOUL.md"] {
            assert!(
                default_spec(Reflect).writable_dirs.contains(&dir),
                "Reflect must be able to write {dir}"
            );
            for s in [Perceive, Express, Settle] {
                assert!(
                    !default_spec(s).writable_dirs.contains(&dir),
                    "{s:?} must not be able to write {dir}"
                );
            }
        }
    }

    #[test]
    fn bash_is_denied_in_every_state() {
        for s in [Perceive, Express, Settle, Reflect] {
            assert!(
                !default_spec(s).tool_scope.allows(ToolClass::Shell),
                "{s:?} must not have raw Shell in scope (it bypasses writable_dirs)"
            );
        }
    }

    #[test]
    fn no_state_may_write_runlogs() {
        for s in [Perceive, Express, Settle, Reflect] {
            assert!(
                !default_spec(s).writable_dirs.iter().any(|d| d.starts_with("runlogs")),
                "{s:?} must not be able to write runlogs/"
            );
        }
    }

    #[test]
    fn transition_invariants() {
        // Perceive opens Express/Settle.
        assert!(allowed_transition(Perceive, Express));
        assert!(allowed_transition(Perceive, Settle));
        // Reflect is harness-entered only: nothing transitions INTO it.
        for s in [Perceive, Express, Settle, Reflect] {
            assert!(!allowed_transition(s, Reflect), "{s:?} → Reflect must be forbidden");
        }
        // Reflect is harness-exited only: it transitions into nothing.
        for s in [Perceive, Express, Settle, Reflect] {
            assert!(!allowed_transition(Reflect, s), "Reflect → {s:?} must be forbidden");
        }
        // Express/Settle do not originate transitions (Express returns transition:none).
        assert!(!allowed_transition(Express, Settle));
        assert!(!allowed_transition(Express, Perceive));
    }

    #[test]
    fn public_tier_reaches_only_perceive() {
        assert_eq!(max_reachable_state(TrustTier::Public), Perceive);
        assert_eq!(max_reachable_state(TrustTier::OperatorSigned), Settle);
    }
}
