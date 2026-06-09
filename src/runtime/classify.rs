//! Map OpenClaude's raw permission event `(tool_name, input)` to a [`ToolClass`] +
//! optional target path (PRD §6.3, grounded against OpenClaude 0.15.0).
//!
//! The SDK/gRPC permission callback hands us `(name, input, toolUseID)` — NOT a
//! pre-classified event — so the responder derives the class here. **Fail-closed:**
//! anything unrecognized → [`ToolClass::Other`], which no state scopes by default, so an
//! unknown or future tool is denied until explicitly allowed.
//!
//! Capability identity:
//! - **Reversible capabilities are MCP tools** (`mcp__twitter__post`, …) → [`Post`], by a
//!   config prefix list. They are MCP tools, not bash scripts, so they have clean names.
//! - **Irreversible capabilities are MCP tools** (`mcp__bankr__send`, `mcp__dac__vote`) →
//!   [`SettleTx`], by a config prefix list.
//! - **Raw shell** (Bash/PowerShell/REPL) → [`Shell`], denied everywhere (it would bypass
//!   `writable_dirs` path-gating).

use serde_json::Value;

use crate::state::ToolClass;

/// Returns `(class, target_path)`. `target_path` is `Some` only for file-write tools,
/// extracted from the input so the responder can check it against `writable_dirs`.
pub fn classify_tool(
    tool: &str,
    input: &Value,
    settle_tools: &[String],
    post_tools: &[String],
    read_tools: &[String],
) -> (ToolClass, Option<String>) {
    // Config-driven capability tools win first, most-privileged first (settle > post > read), so
    // an irreversible prefix can never be shadowed by a looser one. Derived from the `mcp_servers`
    // registry tiers (PRD §6.3).
    if settle_tools.iter().any(|p| tool.starts_with(p.as_str())) {
        return (ToolClass::SettleTx, None);
    }
    if post_tools.iter().any(|p| tool.starts_with(p.as_str())) {
        return (ToolClass::Post, None);
    }
    // Registered monitoring MCPs (e.g. cove-read) → Read: safe in every state.
    if read_tools.iter().any(|p| tool.starts_with(p.as_str())) {
        return (ToolClass::Read, None);
    }

    match tool {
        // Pure reads (OpenClaude tool names + common aliases).
        "Read" | "FileRead" | "Grep" | "Glob" | "LS" | "LSP" | "WebFetch" | "WebSearch"
        | "ReadMcpResource" | "ListMcpResources" | "ToolSearch" | "TaskGet" | "TaskList"
        | "TaskOutput" | "NotebookRead" => (ToolClass::Read, None),

        // File writes — the path decides memory vs soul (gated by writable_dirs).
        "Write" | "FileWrite" | "Edit" | "FileEdit" | "MultiEdit" | "NotebookEdit" => {
            (ToolClass::FileWrite, extract_path(input))
        }

        // Arbitrary execution — denied in every v1 state.
        "Bash" | "BashOutput" | "KillShell" | "PowerShell" | "REPL" => (ToolClass::Shell, None),

        // Unknown / Agent / Skill / other MCP → fail-closed.
        _ => (ToolClass::Other, None),
    }
}

/// Extract a write target path from a file-tool's input (`file_path`, then `path`).
fn extract_path(input: &Value) -> Option<String> {
    input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const POST: &[&str] = &["mcp__twitter__"];
    const SETTLE: &[&str] = &["mcp__bankr__", "mcp__dac__", "mcp__cove-trading__"];
    const READ: &[&str] = &["mcp__cove-read__"];

    fn post() -> Vec<String> {
        POST.iter().map(|s| s.to_string()).collect()
    }
    fn settle() -> Vec<String> {
        SETTLE.iter().map(|s| s.to_string()).collect()
    }
    fn read() -> Vec<String> {
        READ.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_and_writes_classify() {
        assert_eq!(classify_tool("Grep", &json!({}), &settle(), &post(), &read()).0, ToolClass::Read);
        let (c, p) = classify_tool("Write", &json!({"file_path": "memory/log.md"}), &settle(), &post(), &read());
        assert_eq!(c, ToolClass::FileWrite);
        assert_eq!(p.as_deref(), Some("memory/log.md"));
    }

    #[test]
    fn capabilities_classify_by_prefix() {
        assert_eq!(classify_tool("mcp__twitter__post", &json!({}), &settle(), &post(), &read()).0, ToolClass::Post);
        assert_eq!(classify_tool("mcp__bankr__send", &json!({}), &settle(), &post(), &read()).0, ToolClass::SettleTx);
        // A registered monitoring MCP → Read (safe); the trading sibling → SettleTx (irreversible).
        assert_eq!(classify_tool("mcp__cove-read__price", &json!({}), &settle(), &post(), &read()).0, ToolClass::Read);
        assert_eq!(classify_tool("mcp__cove-trading__buy", &json!({}), &settle(), &post(), &read()).0, ToolClass::SettleTx);
    }

    #[test]
    fn bash_is_shell_and_unknown_is_other() {
        assert_eq!(classify_tool("Bash", &json!({"command": "ls"}), &settle(), &post(), &read()).0, ToolClass::Shell);
        // Fail-closed: a tool we don't recognize is Other (→ default-denied).
        assert_eq!(classify_tool("SomeFutureTool", &json!({}), &settle(), &post(), &read()).0, ToolClass::Other);
    }
}
