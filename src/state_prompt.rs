//! **State-prompts** (MCP2-B) — the soul-owned chain-of-thought (PRD §6.3.1). A state-prompt is a
//! named variant of a consciousness state: `(state-tier, prompt body, MCP plan, allowed
//! transitions)`. They live in a **nested filesystem tree mirroring `stimuli/`** — e.g.
//! `prompts/settle.md`, `prompts/twitter/perceive_mention.md`, `prompts/twitter/feed_reply.md` —
//! and a state-prompt's **id is its path relative to `prompts/`, without the extension**
//! (`twitter/perceive_mention`).
//!
//! The split (architecture §2, invariant I16): the **operator owns the WALL** (which consciousness
//! tiers exist, their reversibility, and — via `tier_policy` — which MCP classes a tier admits); the
//! **soul owns the PATH** (which state-prompts run, in what order, and which *permitted* MCPs each
//! plugs). The frontmatter here is the soul's half; it can only ever REQUEST a capability — the
//! operator's `tier_policy` and the wall decide whether it is granted.
//!
//! **frontmatter is config; the body is the directive text** (trusted; PRD §5.3), exactly as in
//! `stimuli/`. The harness reads a state-prompt **live** from the soul repo each time it is opened,
//! so a Reflect edit takes effect on the next wake.

use serde::{Deserialize, Serialize};

use crate::error::{DackError, Result};
use crate::state::ConsciousnessState;
use crate::stimuli::split_frontmatter;

/// One MCP the soul asks a state-prompt to plug. Either a **bare ref** (a string naming an
/// operator-registered `mcp_servers` entry to import — its token stays operator-side, never in the
/// agent context) or an **inline** public MCP `{name, url}` the soul adds itself (no secret →
/// **forced read-tier** by the harness; a soul can never inline a post/settle tool). The
/// `tier_policy` for the state decides whether either form is actually admitted (I16).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum McpRef {
    /// Import an operator-registered server by `name` (token injected by the harness broker).
    Import(String),
    /// A public, secret-less MCP the soul declares inline — forced to read-tier on assembly.
    Inline { name: String, url: String },
}

impl McpRef {
    /// The server name this ref resolves to (the import name, or the inline `name`).
    pub fn name(&self) -> &str {
        match self {
            McpRef::Import(n) => n,
            McpRef::Inline { name, .. } => name,
        }
    }
}

/// Opt-in **sticky session** for a state-prompt (resume-by-id): the engine session is kept and
/// resumed across items that share the same key, so the prompt accumulates context (e.g. all replies
/// in one thread) instead of re-paying it per item. The session key is always `(prompt-id, cycle
/// taint, …key dims)` — `key` adds the extra dimensions resolved from the stimulus (`thread_id` →
/// the stimulus `dedup_key`/`conversation_id`). `sticky: false`/absent = a fresh session each run
/// (the firebreak default). The firebreak still holds: a *different* state-prompt is a different key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionConfig {
    #[serde(default)]
    pub sticky: bool,
    /// Extra key dimensions beyond `(prompt-id, taint)` — e.g. `[thread_id]`. Empty = sticky per
    /// (prompt, taint). Not capped: any number of dims, each resolved from the stimulus.
    #[serde(default)]
    pub key: Vec<String>,
}

/// The YAML frontmatter of a `prompts/**/*.md` state-prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatePromptFrontmatter {
    /// The consciousness tier this prompt runs in (operator-bounded — the wall + ceiling gate it).
    pub state: ConsciousnessState,
    /// The MCPs the soul requests for this prompt (subject to the two-sided handshake). Empty = none.
    #[serde(default)]
    pub mcp: Vec<McpRef>,
    /// The **allowed set** of next state-prompt ids. Each run picks **exactly one** (or terminates);
    /// the chosen target's `state` tier is ceiling-checked before it opens. Empty = terminal.
    #[serde(default)]
    pub transitions: Vec<String>,
    /// Optional per-prompt model override (the soul's half of the model handshake). Honored ONLY
    /// where the operator's `tier_policy[state].allow_model_override` is set; otherwise ignored in
    /// favour of the operator's per-state default, then the global `config.model` (I16 shape).
    #[serde(default)]
    pub model: Option<String>,
    /// Optional sticky-session config (resume-by-id). `None`/`sticky:false` = a fresh session per run.
    #[serde(default)]
    pub session: Option<SessionConfig>,
    /// The payload-item FIELD a baton's `reply_to` is matched against — the reply identifier the model
    /// copies from `payload.items` (e.g. `message_id`). The harness validates `reply_to` against this
    /// field of the batch it holds (the firebreak), then resolves the reply destination from the
    /// matched item. `None` = the platform-agnostic default (`message_id`, then `id`). Generic: a
    /// twitter prompt would set `reply_key: id`.
    #[serde(default)]
    pub reply_key: Option<String>,
}

/// A parsed state-prompt: its id (path), frontmatter, and the trusted directive body.
#[derive(Debug, Clone)]
pub struct StatePrompt {
    /// Path relative to `prompts/`, without extension — e.g. `twitter/perceive_mention`.
    pub id: String,
    pub state: ConsciousnessState,
    pub mcp: Vec<McpRef>,
    pub transitions: Vec<String>,
    /// Soul-requested model override (operator-gated at assembly). `None` = the configured default.
    pub model: Option<String>,
    /// Sticky-session opt-in (resume-by-id). `None` = a fresh session each run (firebreak default).
    pub session: Option<SessionConfig>,
    /// The reply-identifier field a baton's `reply_to` is matched against (default `message_id`→`id`).
    pub reply_key: Option<String>,
    /// The directive text (the body below the frontmatter fence). Trusted.
    pub body: String,
}

impl StatePrompt {
    /// Parse a `prompts/<id>.md` document (frontmatter + body) into a [`StatePrompt`].
    pub fn parse(id: impl Into<String>, text: &str) -> Result<Self> {
        let id = id.into();
        let (yaml, body) = split_frontmatter(text)?;
        let fm: StatePromptFrontmatter = serde_yaml::from_str(yaml).map_err(|e| {
            DackError::Stimulus(format!("state-prompt `{id}` frontmatter: {e}"))
        })?;
        Ok(StatePrompt {
            id,
            state: fm.state,
            mcp: fm.mcp,
            transitions: fm.transitions,
            model: fm.model,
            session: fm.session,
            reply_key: fm.reply_key,
            body: body.trim().to_string(),
        })
    }

    /// The payload-item field(s) a baton's `reply_to` is matched against (the reply identifier). The
    /// soul declares it per-prompt (`reply_key`); unset = the platform-agnostic default
    /// `message_id`→`id` (covers telegram + twitter without config).
    pub fn reply_key_fields(&self) -> Vec<&str> {
        match &self.reply_key {
            Some(k) => vec![k.as_str()],
            None => vec!["message_id", "id"],
        }
    }

    /// The repo-relative file a state-prompt id resolves to (`prompts/<id>.md`).
    pub fn repo_path(id: &str) -> String {
        format!("prompts/{id}.md")
    }

    /// Whether `next` is in this prompt's declared transition set (the soul's half of the gate).
    pub fn permits_transition_to(&self, next: &str) -> bool {
        self.transitions.iter().any(|t| t == next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_state_tier_mcp_and_transitions() {
        let text = "---\nstate: perceive\nmcp:\n  - cove-read\n  - { name: rootai, url: https://mcp.rootai.xyz }\ntransitions: [twitter/feed_reply, twitter/express_market_insights]\n---\nRead the room.\n";
        let sp = StatePrompt::parse("twitter/perceive_feed", text).unwrap();
        assert_eq!(sp.state, ConsciousnessState::Perceive);
        assert_eq!(sp.mcp.len(), 2);
        assert_eq!(sp.mcp[0], McpRef::Import("cove-read".into()));
        assert_eq!(
            sp.mcp[1],
            McpRef::Inline { name: "rootai".into(), url: "https://mcp.rootai.xyz".into() }
        );
        assert!(sp.permits_transition_to("twitter/feed_reply"));
        assert!(!sp.permits_transition_to("settle/cove"));
        assert_eq!(sp.body, "Read the room.");
        assert_eq!(StatePrompt::repo_path("twitter/perceive_feed"), "prompts/twitter/perceive_feed.md");
    }

    #[test]
    fn minimal_prompt_has_no_mcp_or_transitions() {
        let sp = StatePrompt::parse("settle", "---\nstate: settle\n---\nAct.").unwrap();
        assert_eq!(sp.state, ConsciousnessState::Settle);
        assert!(sp.mcp.is_empty());
        assert!(sp.transitions.is_empty());
    }

    #[test]
    fn reply_key_fields_default_and_declared() {
        // Declared → that one field; the model's `reply_to` is matched against it.
        let sp = StatePrompt::parse(
            "telegram/perceive",
            "---\nstate: perceive\nreply_key: message_id\ntransitions: [telegram/express]\n---\nRead.",
        )
        .unwrap();
        assert_eq!(sp.reply_key_fields(), vec!["message_id"]);
        // Unset → the platform-agnostic default (message_id, then id).
        let sp = StatePrompt::parse("settle", "---\nstate: settle\n---\nAct.").unwrap();
        assert_eq!(sp.reply_key_fields(), vec!["message_id", "id"]);
    }
}
