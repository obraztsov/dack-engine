//! **Agent definitions** (Phase 10) — the soul-owned `agents/**/*.md` workforce defs the duck may
//! delegate to. Two roles, one shape:
//! - the **lead worker** (e.g. `coder`) the duck spawns ASYNC (harness-launched, sandboxed) — its
//!   `prompt`/`tools` drive a fresh, keyless `/workspace` invocation;
//! - the **sub-helpers** (e.g. `planner`/`researcher`/`qa`) the lead spawns SYNC via the SDK `Task`
//!   tool — passed to that worker's `options.agents`.
//!
//! Format = frontmatter config + the body as the agent `prompt` (same `prompts/` convention). Loaded
//! ONLY from the soul repo (never on-disk `.claude/agents`), Reflect-writable — so nothing outside
//! the soul can become launchable. A def grants a *workspace + scoped toolset + brief*, NEVER a DID,
//! the duck's Post/Settle creds, or soul access (`agents/README.md`).

use serde::{Deserialize, Serialize};

use crate::error::{DackError, Result};
use crate::stimuli::split_frontmatter;

/// The YAML frontmatter of an `agents/**/*.md` def (the openclaude agent-definition fields, plus the
/// harness-only `isolation`). The agent `prompt` is the markdown body, not a frontmatter field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentFrontmatter {
    pub description: String,
    /// Allowed tool names (SDK `options.agents[].tools`). `None` = the engine default for the role.
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    /// Denied tool names (`disallowedTools`). Sub-helpers set `[Task]` here to cap nesting.
    #[serde(default, rename = "disallowedTools")]
    pub disallowed_tools: Option<Vec<String>>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, rename = "maxTurns")]
    pub max_turns: Option<u32>,
    /// Harness-only: `worktree` runs the worker in a git worktree (NOT sent to the SDK).
    #[serde(default)]
    pub isolation: Option<String>,
}

/// A parsed agent definition: its id (path under `agents/`, no extension) + frontmatter + the prompt.
#[derive(Debug, Clone)]
pub struct AgentDef {
    pub id: String,
    pub fm: AgentFrontmatter,
    /// The agent's system prompt (the body below the frontmatter fence). Trusted (soul-authored).
    pub prompt: String,
}

impl AgentDef {
    /// Parse an `agents/<id>.md` document (frontmatter + body → prompt).
    pub fn parse(id: impl Into<String>, text: &str) -> Result<Self> {
        let id = id.into();
        let (yaml, body) = split_frontmatter(text)?;
        let fm: AgentFrontmatter = serde_yaml::from_str(yaml)
            .map_err(|e| DackError::Stimulus(format!("agent `{id}` frontmatter: {e}")))?;
        Ok(AgentDef { id, fm, prompt: body.trim().to_string() })
    }

    /// The repo-relative file an agent id resolves to (`agents/<id>.md`).
    pub fn repo_path(id: &str) -> String {
        format!("agents/{id}.md")
    }

    /// Render this def into an SDK `options.agents` value (`{description, prompt, tools?,
    /// disallowedTools?, model?, maxTurns?}`) — what a worker registers so it can `Task`-spawn it.
    /// `isolation` is harness-only and intentionally omitted.
    pub fn to_options_value(&self) -> serde_json::Value {
        let mut m = serde_json::Map::new();
        m.insert("description".into(), serde_json::json!(self.fm.description));
        m.insert("prompt".into(), serde_json::json!(self.prompt));
        if let Some(t) = &self.fm.tools {
            m.insert("tools".into(), serde_json::json!(t));
        }
        if let Some(d) = &self.fm.disallowed_tools {
            m.insert("disallowedTools".into(), serde_json::json!(d));
        }
        // `model: inherit` means "use the worker's model" — don't pin it on the sub-helper.
        if let Some(model) = self.fm.model.as_deref().filter(|m| *m != "inherit") {
            m.insert("model".into(), serde_json::json!(model));
        }
        if let Some(mt) = self.fm.max_turns {
            m.insert("maxTurns".into(), serde_json::json!(mt));
        }
        serde_json::Value::Object(m)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_agent_def_and_renders_options_value() {
        let text = "---\ndescription: a coder\ntools: [Read, Write, Bash, Task]\nmodel: inherit\nmaxTurns: 40\nisolation: worktree\n---\nYou are a coding worker. Build to the brief.\n";
        let a = AgentDef::parse("coder", text).unwrap();
        assert_eq!(a.id, "coder");
        assert_eq!(a.fm.isolation.as_deref(), Some("worktree"));
        assert_eq!(a.prompt, "You are a coding worker. Build to the brief.");
        let v = a.to_options_value();
        assert_eq!(v["description"], serde_json::json!("a coder"));
        assert_eq!(v["prompt"], serde_json::json!("You are a coding worker. Build to the brief."));
        assert_eq!(v["tools"], serde_json::json!(["Read", "Write", "Bash", "Task"]));
        assert_eq!(v["maxTurns"], serde_json::json!(40));
        // `inherit` model + harness-only isolation are NOT sent to the SDK.
        assert!(v.get("model").is_none());
        assert!(v.get("isolation").is_none());
    }
}
