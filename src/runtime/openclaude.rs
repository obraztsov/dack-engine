//! OpenClaude runtime adapter (PRD §5, §6) — v1 [`RuntimeClient`], grounded against
//! OpenClaude 0.15.0 (`docs/VERIFICATION.md`).
//!
//! **Decision: public SDK, no fork; transport = NDJSON over stdio to a thin TS bridge.**
//! OpenClaude is Node-side, so a small `bridge.ts` runs the SDK `query()` and this Rust
//! client drives it as a child process: one line in (`invoke`), a stream of `permission`
//! events out (each answered by the Rust [`ActionResponder`] — **the wall**), and a final
//! `result` carrying the structured [`AgentOutput`] (the SDK has no public JSON-schema output,
//! so the bridge instructs the model to make its FINAL message a JSON object and parses it —
//! provider-agnostic, unlike an MCP `submit` tool which perturbed provider routing;
//! live-verified Phase 4, `docs/VERIFICATION.md`).
//!
//! Why stdio, not gRPC: no `protoc`/`tonic`/ports, and a pipe to a child is *more* confined
//! than a localhost socket (nothing binds, nothing impersonable). The approval channel
//! (PRD §6.3) is the child's stdin/stdout — local by construction.
//!
//! The client is parameterized by its spawn `command`, so it drives the real `bun run
//! bridge.ts` in production and a mock script in tests (same protocol, no network).

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::{ActionDecision, ActionRequest, ActionResponder, InvocationRequest, RuntimeClient};
use crate::error::{DackError, Result};
use crate::model::proposal::AgentOutput;
use crate::sandbox::{ExecKind, HostSandbox, IsolationPolicy, Mount, ProcessSpec, Sandbox};

/// Tools we deny at the engine boundary too (defense-in-depth over the wall, which already
/// denies the `Shell` class in every state — `docs/VERIFICATION.md` "Memory access model").
/// Raw shell bypasses path-gating, so it never belongs in a duck state.
const ALWAYS_DISALLOWED: &[&str] = &["Bash", "PowerShell", "REPL", "KillShell"];

/// Rust → bridge.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ToBridge<'a> {
    Invoke {
        system_prompt: &'a str,
        user_prompt: String,
        disallowed_tools: Vec<String>,
        allowed_tools: Option<Vec<String>>,
        model: Option<&'a str>,
        /// The agent's working dir (the soul repo) → the bridge's `options.cwd`.
        cwd: Option<&'a str>,
        /// Resolved MCP capability servers (SDK-shaped, tokens injected) → `options.mcpServers`.
        mcp_servers: &'a std::collections::BTreeMap<String, serde_json::Value>,
    },
    Decision {
        tool_use_id: String,
        allow: bool,
        message: Option<String>,
    },
}

/// bridge → Rust.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum FromBridge {
    /// A `canUseTool` event: answer via the wall, then reply with a `Decision`.
    Permission {
        tool: String,
        tool_use_id: String,
        #[serde(default)]
        input: serde_json::Value,
    },
    /// The run finished; `output` is the agent's `submit`ted structured proposal.
    Result { output: AgentOutput },
    /// The run failed inside the engine/bridge.
    Error { message: String },
    /// Diagnostic passthrough (surfaced to the harness log).
    Log { message: String },
}

pub struct OpenClaudeClient {
    /// How to spawn the bridge, e.g. `["bun", "run", "bridge.ts"]`. In tests, a mock script.
    pub command: Vec<String>,
    /// Working dir for the spawn (the `openclaude-bridge/` project in production).
    pub cwd: Option<PathBuf>,
    /// Env **overlaid** on the inherited process env for the bridge (provider key/base-URL +
    /// `forwarded_env`). We inherit rather than clear because the engine's auth context can
    /// live in ambient env the SDK requires; the soul key is never in env regardless
    /// (PRD §7.2 — it is a `file://` secret ref).
    pub env: HashMap<String, String>,
    /// Model id passed to the SDK (e.g. `mimo-v2.5-pro`); `None` = bridge/provider default.
    pub model: Option<String>,
    /// Isolation backend for the bridge process (default [`HostSandbox`]). Under a container
    /// backend the **soul repo (`workdir`) is mounted as a writable volume** so the agent's
    /// memory/skill writes land while the rest of the box stays out of reach.
    pub sandbox: Arc<dyn Sandbox>,
    pub policy: IsolationPolicy,
    /// Wall-clock budget for one whole invocation (incl. the wall round-trips). A hung LLM/bridge
    /// would otherwise freeze the single-flight loop forever; on elapse `invoke` returns a
    /// `Runtime` error (dispatch logs + continues) and `kill_on_drop` reaps the child (PRD §11.8).
    pub timeout: Duration,
}

impl OpenClaudeClient {
    /// The production bridge: `bun run bridge.ts` inside the `openclaude-bridge/` project.
    pub fn bun_bridge(
        bridge_dir: impl Into<PathBuf>,
        env: HashMap<String, String>,
        model: Option<String>,
        timeout: Duration,
    ) -> Self {
        Self {
            command: vec!["bun".into(), "run".into(), "bridge.ts".into()],
            cwd: Some(bridge_dir.into()),
            env,
            model,
            sandbox: Arc::new(HostSandbox),
            policy: IsolationPolicy::host_passthrough(),
            timeout,
        }
    }

    /// Render context blocks into one user turn with **visible trust framing** (PRD §5.3):
    /// the trusted directive and the untrusted world data are fenced and labelled so the
    /// model (and any reviewer) can see which is which. Framing lives here, in the harness.
    fn render_blocks(blocks: &[super::ContextBlock]) -> String {
        blocks
            .iter()
            .map(|b| {
                let tag = if b.trusted {
                    "TRUSTED-DIRECTIVE"
                } else {
                    "UNTRUSTED-WORLD-DATA"
                };
                format!("<{tag} label=\"{}\">\n{}\n</{tag}>", b.label, b.body)
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

#[async_trait]
impl RuntimeClient for OpenClaudeClient {
    async fn invoke(
        &self,
        req: InvocationRequest,
        responder: Arc<dyn ActionResponder>,
    ) -> Result<AgentOutput> {
        // Spawn the bridge **through the sandbox seam** (HostSandbox by default). Under a
        // container backend the soul repo (workdir) is mounted writable; the harness env is
        // inherited (the SDK's auth context is ambient — Phase 4 learning), never cleared.
        // Static bridge env (provider key/base-URL) + the per-invocation act secrets the
        // harness materialized for this Express run (the skills read them). Perceive's is empty.
        let mut env: std::collections::BTreeMap<String, String> =
            self.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        env.extend(req.secret_env.clone());
        let spec = ProcessSpec {
            command: self.command.clone(),
            cwd: self.cwd.clone().unwrap_or_else(|| PathBuf::from(".")),
            env,
            clear_env: false,
            kind: ExecKind::Agent,
            mounts: req
                .workdir
                .as_ref()
                .map(|w| {
                    vec![Mount {
                        host: w.clone(),
                        guest: w.clone(),
                        writable: true,
                    }]
                })
                .unwrap_or_default(),
            policy: self.policy.clone(),
        };
        let mut child = self
            .sandbox
            .command(&spec)?
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| DackError::Runtime(format!("spawn bridge: {e}")))?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| DackError::Runtime("bridge stdin unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| DackError::Runtime("bridge stdout unavailable".into()))?;
        let mut lines = BufReader::new(stdout).lines();

        // Send the one invocation. stdin stays open for decision replies.
        let invoke = ToBridge::Invoke {
            system_prompt: &req.system_prompt,
            user_prompt: Self::render_blocks(&req.blocks),
            disallowed_tools: ALWAYS_DISALLOWED.iter().map(|s| s.to_string()).collect(),
            allowed_tools: None,
            // Per-invocation override (8.7) wins; else the client's configured default.
            model: req.model.as_deref().or(self.model.as_deref()),
            cwd: req.workdir.as_deref().and_then(|p| p.to_str()),
            mcp_servers: &req.mcp_servers,
        };

        // The whole exchange (send → permission round-trips → result) runs under ONE wall-clock
        // budget. A hung LLM/bridge turn elapses here instead of freezing the single-flight loop
        // forever; on return the child is reaped by `kill_on_drop` (PRD §11.8).
        let drive = async {
            write_line(&mut stdin, &invoke).await?;
            loop {
                let line = lines
                    .next_line()
                    .await
                    .map_err(|e| DackError::Runtime(format!("bridge read: {e}")))?;
                let Some(line) = line else {
                    return Err(DackError::Runtime("bridge closed before result".into()));
                };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<FromBridge>(&line).map_err(|e| {
                    DackError::Runtime(format!("bridge event parse: {e} (line: {line})"))
                })? {
                    FromBridge::Permission {
                        tool,
                        tool_use_id,
                        input,
                    } => {
                        let decision = responder
                            .decide(&ActionRequest {
                                tool,
                                tool_use_id: tool_use_id.clone(),
                                input,
                            })
                            .await;
                        let (allow, message) = match decision {
                            ActionDecision::Allow => (true, None),
                            ActionDecision::Deny(why) => (false, Some(why)),
                        };
                        write_line(
                            &mut stdin,
                            &ToBridge::Decision {
                                tool_use_id,
                                allow,
                                message,
                            },
                        )
                        .await?;
                    }
                    FromBridge::Result { output } => return Ok(output),
                    FromBridge::Error { message } => return Err(DackError::Runtime(message)),
                    FromBridge::Log { message } => eprintln!("[bridge] {message}"),
                }
            }
        };

        match tokio::time::timeout(self.timeout, drive).await {
            Ok(result) => result,
            Err(_elapsed) => Err(DackError::Runtime(format!(
                "invoke exceeded its {:?} budget (LLM/bridge hung)",
                self.timeout
            ))),
        }
    }
}

async fn write_line<W: AsyncWriteExt + Unpin>(w: &mut W, msg: &ToBridge<'_>) -> Result<()> {
    let mut buf = serde_json::to_vec(msg)?;
    buf.push(b'\n');
    w.write_all(&buf)
        .await
        .map_err(|e| DackError::Runtime(format!("bridge write: {e}")))?;
    w.flush()
        .await
        .map_err(|e| DackError::Runtime(format!("bridge flush: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::ContextBlock;
    use crate::state::{default_spec, ConsciousnessState};
    use std::sync::Mutex;

    /// A recording responder: captures every tool it was asked about, returns a fixed verdict.
    struct Recorder {
        asked: Mutex<Vec<String>>,
        allow: bool,
    }
    #[async_trait]
    impl ActionResponder for Recorder {
        async fn decide(&self, req: &ActionRequest) -> ActionDecision {
            self.asked.lock().unwrap().push(req.tool.clone());
            if self.allow {
                ActionDecision::Allow
            } else {
                ActionDecision::Deny("test deny".into())
            }
        }
    }

    /// Write a `/bin/sh` mock bridge and return a client that spawns it.
    fn mock_client(script: &str, tag: &str) -> OpenClaudeClient {
        let dir = std::env::temp_dir().join(format!("dack-bridge-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mock.sh");
        std::fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut env = HashMap::new();
        if let Ok(p) = std::env::var("PATH") {
            env.insert("PATH".into(), p);
        }
        OpenClaudeClient {
            command: vec!["/bin/sh".into(), path.to_string_lossy().into()],
            cwd: None,
            env,
            model: None,
            sandbox: Arc::new(HostSandbox),
            policy: IsolationPolicy::host_passthrough(),
            timeout: Duration::from_secs(30),
        }
    }

    fn perceive_req() -> InvocationRequest {
        InvocationRequest {
            spec: default_spec(ConsciousnessState::Perceive),
            system_prompt: "SOUL + perceive".into(),
            blocks: vec![ContextBlock {
                label: "world".into(),
                body: "a tweet".into(),
                trusted: false,
            }],
            session: None,
            workdir: None,
            secret_env: Default::default(),
            mcp_servers: Default::default(),
            model: None,
        }
    }

    #[tokio::test]
    async fn relays_permission_to_the_wall_then_parses_result() {
        // The mock induces one permission event, blocks until the decision arrives
        // (proving the round-trip), then returns a structured result.
        let mock = "#!/bin/sh\n\
            read invoke\n\
            printf '{\"kind\":\"permission\",\"tool\":\"Write\",\"tool_use_id\":\"tu_1\",\"input\":{\"file_path\":\"/x/p.txt\"}}\\n'\n\
            read decision\n\
            printf '{\"kind\":\"result\",\"output\":{\"thought\":\"done\",\"transition\":{\"to_prompt\":null}}}\\n'\n";
        let client = mock_client(mock, "perm");
        let rec = Arc::new(Recorder {
            asked: Mutex::new(vec![]),
            allow: false,
        });
        let out = client.invoke(perceive_req(), rec.clone()).await.unwrap();

        assert_eq!(out.thought, "done");
        assert!(out.transition.to_prompt.is_none());
        // The wall WAS consulted with the real tool; the mock only reached `result`
        // because the decision line was delivered (it blocks on `read decision`).
        assert_eq!(*rec.asked.lock().unwrap(), vec!["Write".to_string()]);
    }

    #[tokio::test]
    async fn result_only_run_needs_no_decisions() {
        let mock = "#!/bin/sh\n\
            read invoke\n\
            printf '{\"kind\":\"result\",\"output\":{\"thought\":\"hi\",\"proposal\":{\"intent\":\"noop\",\"gist\":\"g\"},\"transition\":{\"to_state\":null}}}\\n'\n";
        let client = mock_client(mock, "resultonly");
        let rec = Arc::new(Recorder {
            asked: Mutex::new(vec![]),
            allow: true,
        });
        let out = client.invoke(perceive_req(), rec).await.unwrap();
        assert_eq!(out.thought, "hi");
        assert_eq!(out.proposal.unwrap().gist, "g");
    }

    #[tokio::test]
    async fn invoke_times_out_on_a_hung_bridge() {
        // The mock reads the invoke, then hangs (never emits a result) — the budget must fire.
        let mock = "#!/bin/sh\n\
            read invoke\n\
            sleep 30\n";
        let mut client = mock_client(mock, "hang");
        client.timeout = Duration::from_millis(250); // tight budget for the test
        let rec = Arc::new(Recorder { asked: Mutex::new(vec![]), allow: true });
        let err = client.invoke(perceive_req(), rec).await.unwrap_err();
        assert!(
            matches!(err, DackError::Runtime(m) if m.contains("budget")),
            "a hung bridge must time out, not freeze the loop"
        );
    }

    #[tokio::test]
    async fn bridge_error_becomes_runtime_error() {
        let mock = "#!/bin/sh\n\
            read invoke\n\
            printf '{\"kind\":\"error\",\"message\":\"provider 401\"}\\n'\n";
        let client = mock_client(mock, "err");
        let rec = Arc::new(Recorder {
            asked: Mutex::new(vec![]),
            allow: true,
        });
        let err = client.invoke(perceive_req(), rec).await.unwrap_err();
        assert!(matches!(err, DackError::Runtime(m) if m.contains("provider 401")));
    }

    #[test]
    fn render_frames_trusted_and_untrusted_blocks() {
        let s = OpenClaudeClient::render_blocks(&[
            ContextBlock { label: "dir".into(), body: "do x".into(), trusted: true },
            ContextBlock { label: "world".into(), body: "evil".into(), trusted: false },
        ]);
        assert!(s.contains("<TRUSTED-DIRECTIVE label=\"dir\">"));
        assert!(s.contains("<UNTRUSTED-WORLD-DATA label=\"world\">"));
    }
}
