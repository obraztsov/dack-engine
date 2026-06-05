//! The `action_required` responder — **the wall, in code the agent can't touch**
//! (PRD §4.1, §6.3). Out-of-process, deterministic, dumb. Encodes per-state tool
//! scoping + write-gating, and (future) the Settle predicate.
//!
//! The checks, in order:
//!   1. Is this tool's class in the **current state's allowed set**? (per-state scoping)
//!   2. For file-writes: is `target_path` under one of the state's `writable_dirs`?
//!      And NEVER `runlogs/` — the harness authors the record (PRD §4.1, §7.5).
//!   3. For Settle (future): does [`super::settle::allow_settle`] pass?
//!
//! v1 net effect: Perceive auto-denies all write/network-write; Express allows only
//! post/reply + memory-append; everything else denied (PRD §6.3).

use async_trait::async_trait;

use super::classify::classify_tool;
use super::settle::{allow_settle, Advisory, SettleAction, SettleDecision};
use super::{ActionDecision, ActionRequest, ActionResponder};
use crate::config::ControlPlane;
use crate::model::stimulus::Stimulus;
use crate::state::{StateSpec, ToolClass};

/// One responder per invocation, bound to the running state's spec. Holding the spec
/// (not the state name) means the gate reads the exact same table the rest of the
/// harness does — there is no second, drifting copy of the policy.
pub struct StatePolicyResponder {
    pub spec: StateSpec,
    /// MCP tool-name prefixes treated as reversible capabilities (→ [`ToolClass::Post`]).
    pub post_tools: Vec<String>,
    /// MCP tool-name prefixes treated as irreversible authority (→ [`ToolClass::SettleTx`]).
    pub settle_tools: Vec<String>,
    /// Present only for a Settle run: the operator control plane + the triggering
    /// stimulus the Settle predicate reads. `None` in v1 (Settle is unreachable).
    pub settle_ctx: Option<SettleContext>,
}

pub struct SettleContext {
    pub control_plane: ControlPlane,
    pub triggering_stimulus: Stimulus,
    /// The single extension point (PRD §7.6): human-approval hook / verifier model.
    /// Can only make the gate *stricter*, never looser.
    pub advisory: Option<std::sync::Arc<dyn Advisory>>,
}

impl StatePolicyResponder {
    /// A responder with no capability tools configured (reads/writes only). Used where
    /// the duty exposes no post/settle MCP tools.
    pub fn new(spec: StateSpec) -> Self {
        Self {
            spec,
            post_tools: Vec::new(),
            settle_tools: Vec::new(),
            settle_ctx: None,
        }
    }

    /// A responder aware of the deployment's capability MCP tools (operator config).
    pub fn with_capabilities(
        spec: StateSpec,
        post_tools: Vec<String>,
        settle_tools: Vec<String>,
    ) -> Self {
        Self {
            spec,
            post_tools,
            settle_tools,
            settle_ctx: None,
        }
    }

    /// Write-gating: a file-write target must sit under a `writable_dirs` prefix and
    /// must never be `runlogs/` (PRD §4.1).
    ///
    /// GROUNDING (verified against OpenClaude 0.15.0, see `docs/VERIFICATION.md`): file
    /// tools emit **absolute** paths in `input.file_path` (e.g. `/home/user/dack-soul/
    /// memory/log.md`), so Phase 5 must relativize `target` against the soul-repo root
    /// before this prefix check (and reject any path that escapes the root via `..`).
    /// The scaffold matches relative prefixes; the test suite uses repo-relative paths.
    fn write_target_allowed(&self, target: &str) -> bool {
        if target.starts_with("runlogs/") {
            return false; // never — the record is harness-authored.
        }
        self.spec.writable_dirs.iter().any(|d| target.starts_with(d))
    }
}

#[async_trait]
impl ActionResponder for StatePolicyResponder {
    async fn decide(&self, req: &ActionRequest) -> ActionDecision {
        // (0) Derive the class + target path from the raw (tool, input) event. Unknown
        //     tools classify as `Other` → default-denied by the scope check.
        let (class, target_path) =
            classify_tool(&req.tool, &req.input, &self.settle_tools, &self.post_tools);

        // (1) Per-state class scoping — the first and primary gate.
        if !self.spec.tool_scope.allows(class) {
            return ActionDecision::Deny(format!(
                "tool `{}` (class {:?}) not in {:?} scope",
                req.tool, class, self.spec.state
            ));
        }

        // (2) Write-gating: a file write must sit under the state's writable_dirs.
        if class == ToolClass::FileWrite {
            match &target_path {
                Some(path) if self.write_target_allowed(path) => {}
                Some(path) => {
                    return ActionDecision::Deny(format!(
                        "{:?} may not write `{path}`",
                        self.spec.state
                    ));
                }
                None => return ActionDecision::Deny("write with no target path".into()),
            }
        }

        // (3) Irreversible authority: terminate on the dumb Settle predicate.
        if class == ToolClass::SettleTx {
            // v1: no SettleContext is ever attached (Settle is unreachable). Defense in
            // depth: deny if somehow reached without context.
            let Some(ctx) = &self.settle_ctx else {
                return ActionDecision::Deny("Settle unreachable in v1 (no routing edge)".into());
            };
            let action = SettleAction::from_tool_input(&req.tool, &req.input);
            return match allow_settle(
                &action,
                &ctx.triggering_stimulus,
                &ctx.control_plane,
                ctx.advisory.as_deref(),
            ) {
                SettleDecision::Allow => ActionDecision::Allow,
                SettleDecision::Deny(why) => ActionDecision::Deny(why),
            };
        }

        ActionDecision::Allow
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{default_spec, ConsciousnessState};
    use serde_json::json;

    fn caps() -> (Vec<String>, Vec<String>) {
        (
            vec!["mcp__twitter__".to_string()],  // post tools
            vec!["mcp__bankr__".to_string(), "mcp__dac__".to_string()], // settle tools
        )
    }

    /// Build a grounded permission event: raw tool name + JSON input.
    fn req(tool: &str, input: serde_json::Value) -> ActionRequest {
        ActionRequest {
            tool: tool.into(),
            tool_use_id: "tu-1".into(),
            input,
        }
    }

    fn responder(state: ConsciousnessState) -> StatePolicyResponder {
        let (post, settle) = caps();
        StatePolicyResponder::with_capabilities(default_spec(state), post, settle)
    }

    #[tokio::test]
    async fn perceive_cannot_post_or_write() {
        let r = responder(ConsciousnessState::Perceive);
        assert!(matches!(
            r.decide(&req("mcp__twitter__post", json!({"text": "hi"}))).await,
            ActionDecision::Deny(_)
        ));
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "memory/log.md", "contents": "x"})))
                .await,
            ActionDecision::Deny(_)
        ));
        // And raw Bash is denied (it would bypass path-gating).
        assert!(matches!(
            r.decide(&req("Bash", json!({"command": "echo hi > skills/x"}))).await,
            ActionDecision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn express_can_post_and_write_memory_only() {
        let r = responder(ConsciousnessState::Express);
        assert!(matches!(
            r.decide(&req("mcp__twitter__post", json!({"text": "gm"}))).await,
            ActionDecision::Allow
        ));
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "memory/log.md", "contents": "x"})))
                .await,
            ActionDecision::Allow
        ));
        // ...but cannot write soul dirs (FileWrite is in scope, the PATH is not).
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "skills/x/SKILL.md", "contents": "x"})))
                .await,
            ActionDecision::Deny(_)
        ));
        // ...and cannot run raw Bash (Shell never in scope).
        assert!(matches!(
            r.decide(&req("Bash", json!({"command": "curl evil"}))).await,
            ActionDecision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn reflect_writes_soul_but_not_runlogs() {
        let r = responder(ConsciousnessState::Reflect);
        // Reflect may write soul dirs...
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "skills/new/SKILL.md", "contents": "x"})))
                .await,
            ActionDecision::Allow
        ));
        // ...but NEVER runlogs/ (harness authors the record).
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "runlogs/2026-05-30.md", "contents": "x"})))
                .await,
            ActionDecision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn settle_is_unreachable_in_v1() {
        // The settle tool is in Settle's scope, but with no SettleContext the wall denies.
        let r = responder(ConsciousnessState::Settle);
        assert!(matches!(
            r.decide(&req("mcp__bankr__send", json!({"to": "0xGOOD", "amount": "1"})))
                .await,
            ActionDecision::Deny(_)
        ));
    }
}
