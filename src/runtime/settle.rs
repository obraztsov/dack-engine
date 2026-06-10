//! `allow_settle` — the **dumb protective reflex** on irreversible-authority doorways
//! (PRD §7.6). The withdrawal reflex that retracts the hand from fire below conscious
//! override. **Its stupidity is its security**: it does not *judge harm* (that needs
//! intelligence and would explode the harness 10× and rebuild a *persuadable* layer at
//! the exact spot whose job is to be unpersuadable). It checks only lines no persuasion
//! can cross.
//!
//! ```text
//! allow_settle(action, triggering_stimulus, control_plane, advisory?) =
//!       action.contract ∈ control_plane.whitelist          // set membership — dumb
//!     ∧ triggering_stimulus.trust_tier == operator_signed   // RFC 9421 verify — dumb
//! ```
//!
//! **Amount/cap is deliberately NOT a predicate here** — it is enforced by the DAC
//! treasury, where it belongs; duplicating it would couple the harness to value
//! semantics it should not own and create drift / false confidence (PRD §7.6,
//! DAC-context §3.2).
//!
//! The `advisory?` parameter is the single extension point that makes one method serve
//! every deployment (sovereign / corp-human-approval / v3-immune-system). It can only
//! make the gate **stricter** — never looser. The final allow/deny always terminates
//! on the two dumb predicates.
//!
//! v1: Settle is unwired — no routing edge reaches it — so this never fires. It is
//! specified now so the wall is an *addition* later, not a rewrite (PRD §7.6 roadmap).

use async_trait::async_trait;

use crate::model::stimulus::{Stimulus, TrustTier};
use crate::config::ControlPlane;

/// An irreversible action proposed in Settle. v1: a placeholder — populated when EVM /
/// DAC voting is wired (v2).
#[derive(Debug, Clone)]
pub struct SettleAction {
    /// The contract the action targets — checked for whitelist membership.
    pub contract: String,
    /// Action type (vote / disburse / seed-dac …) for the operator-visible record.
    pub action_type: String,
}

impl SettleAction {
    /// Build a settle action from the real OpenClaude permission event `(tool, input)`.
    /// The destination/contract is read from the tool's JSON args — the field name is
    /// per-tool (`to` for a Bankr transfer, `contract` for a DAC call). v1: this never
    /// runs (Settle is unreachable); the extraction map is finalized when v2 wires the
    /// concrete settle MCP tools.
    pub fn from_tool_input(tool: &str, input: &serde_json::Value) -> Self {
        let contract = input
            .get("contract")
            .or_else(|| input.get("to"))
            .or_else(|| input.get("destination"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        SettleAction {
            contract,
            action_type: tool.to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub enum SettleDecision {
    Allow,
    Deny(String),
}

/// The advisory extension point (PRD §7.6). Itself persuadable, so it strengthens the
/// gate's *input* but never *becomes* the gate: if it says "fine" but a dumb predicate
/// says "deny", the dumb predicate wins.
#[async_trait]
pub trait Advisory: Send + Sync {
    /// Returns `false` to VETO (make the gate stricter). It can never widen the gate.
    async fn approves(&self, action: &SettleAction) -> bool;
}

/// The dumb gate. Note `advisory` is accepted by reference here but evaluated by the
/// caller in async context in real wiring; v1 path never reaches a live advisory.
pub fn allow_settle(
    action: &SettleAction,
    triggering_stimulus: &Stimulus,
    control_plane: &ControlPlane,
    _advisory: Option<&dyn Advisory>,
) -> SettleDecision {
    // Predicate 1: whitelisted contract (set membership — dumb).
    if !control_plane.whitelist.contains(&action.contract) {
        return SettleDecision::Deny(format!(
            "contract `{}` not in whitelist",
            action.contract
        ));
    }
    // Predicate 2: the triggering stimulus carries operator provenance (RFC 9421 — dumb).
    // The directive (the standing duty) must be operator-authored AND the world-data
    // that justified acting must itself be operator-signed — only `operator_signed`
    // tier may precondition a Settle edge (PRD §5.7).
    if triggering_stimulus.directive_tier != TrustTier::operator()
        || triggering_stimulus.payload_tier != TrustTier::operator()
    {
        return SettleDecision::Deny("triggering stimulus is not operator_signed".into());
    }
    // Both dumb predicates pass. (advisory, when present, is consulted by the caller and
    // can only DENY — it never appears here as an allow.)
    SettleDecision::Allow
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::stimulus::{Priority, StimulusId, StimulusStatus, StimulusType};

    fn stim(directive: TrustTier, payload: TrustTier) -> Stimulus {
        Stimulus {
            id: StimulusId("s1".into()),
            source: "test".into(),
            type_: StimulusType::from("treasury_action"),
            directive_tier: directive,
            payload_tier: payload,
            payload: serde_json::Value::Null,
            provenance: None,
            received_at: 0,
            dedup_key: None,
            priority: Priority::Normal,
            status: StimulusStatus::Pending,
            directive_body: String::new(),
            entry: "perceive".into(),
        }
    }

    fn cp(whitelist: &[&str]) -> ControlPlane {
        ControlPlane {
            cap_remaining: 0,
            whitelist: whitelist.iter().map(|s| s.to_string()).collect(),
            allowed_action_types: vec![],
        }
    }

    #[test]
    fn denies_non_whitelisted_contract() {
        let action = SettleAction { contract: "0xEVIL".into(), action_type: "vote".into() };
        let s = stim(TrustTier::operator(), TrustTier::operator());
        assert!(matches!(
            allow_settle(&action, &s, &cp(&["0xGOOD"]), None),
            SettleDecision::Deny(_)
        ));
    }

    #[test]
    fn denies_non_operator_trigger() {
        let action = SettleAction { contract: "0xGOOD".into(), action_type: "vote".into() };
        // The laundered-conclusion attack target: a public payload must never settle,
        // no matter how persuasive (PRD §7.6).
        let s = stim(TrustTier::operator(), TrustTier::public());
        assert!(matches!(
            allow_settle(&action, &s, &cp(&["0xGOOD"]), None),
            SettleDecision::Deny(_)
        ));
    }

    #[test]
    fn allows_only_when_both_dumb_predicates_pass() {
        let action = SettleAction { contract: "0xGOOD".into(), action_type: "vote".into() };
        let s = stim(TrustTier::operator(), TrustTier::operator());
        assert!(matches!(
            allow_settle(&action, &s, &cp(&["0xGOOD"]), None),
            SettleDecision::Allow
        ));
    }
}
