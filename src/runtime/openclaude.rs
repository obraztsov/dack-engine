//! OpenClaude runtime adapter (PRD §5, §6) — v1 implementation of [`RuntimeClient`],
//! grounded against OpenClaude 0.15.0 (see `docs/VERIFICATION.md`).
//!
//! **Decision: build on the public SDK (`@gitlawb/openclaude/sdk`), no internal fork.**
//! The SDK's `query()` exposes everything we need as a CI-guarded public surface:
//! - `canUseTool(name, input, {toolUseID}) → {behavior}` — **the wall**. Secure-by-default:
//!   omit it and ALL tools deny. We provide it; it forwards each request to our Rust
//!   [`ActionResponder`](super::ActionResponder) and returns its decision.
//! - `systemPrompt: {type:'custom', content}` — the SOUL + state prompt becomes the real
//!   system prompt (not OpenClaude's default coding-assistant prompt).
//! - `disallowedTools` — defense-in-depth tool restriction layered on the responder.
//! - `model` per call; session continuity via `Query.sessionId` / the v2 session API.
//! - `respondToPermission(toolUseId, decision)` — carries the `toolUseId` the lean gRPC
//!   proto omitted, so correlation is exact.
//!
//! **Topology.** OpenClaude is the engine; this Rust harness is the client/approver. The
//! SDK is Node-side, so a thin TS **bridge** runs `query()` and relays permission events
//! to us. Transport between Rust and the bridge is a seam decision (localhost gRPC to
//! match the PRD topology, or newline-JSON over stdio for simplicity) — finalized in
//! Phase 4; either way the wall stays in this Rust responder.
//!
//! SCAFFOLD: the bridge + transport land in Phase 4. The live SDK round-trip needs
//! `npm install` in `openclaude-0.15.0/` + a provider key; the runbook is in the plan.

use async_trait::async_trait;
use std::sync::Arc;

use super::{ActionResponder, InvocationRequest, RuntimeClient};
use crate::error::Result;
use crate::model::proposal::AgentOutput;

pub struct OpenClaudeClient {
    /// Address of the TS bridge (e.g. `http://127.0.0.1:50051` for gRPC, or a spawned
    /// child for stdio). MUST be localhost — the channel carries approvals (PRD §6.3).
    pub endpoint: String,
}

#[async_trait]
impl RuntimeClient for OpenClaudeClient {
    async fn invoke(
        &self,
        _req: InvocationRequest,
        _responder: Arc<dyn ActionResponder>,
    ) -> Result<AgentOutput> {
        todo!(
            "Phase 4: drive the SDK bridge — send {{prompt, systemPrompt(custom), model, \
             disallowedTools, session}}; on each permission event build an ActionRequest \
             {{tool, tool_use_id, input}} and answer via `responder` → respondToPermission; \
             collect the structured AgentOutput (emitted via a `submit` tool the agent \
             calls — the SDK has no public jsonSchema, so structured output rides a tool \
             call we intercept)."
        )
    }
}
