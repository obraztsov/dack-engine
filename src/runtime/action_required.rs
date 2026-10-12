//! The `action_required` responder — **the wall, in code the agent can't touch**
//! Out-of-process, deterministic, dumb. Encodes per-state tool
//! scoping + write-gating, and (future) the Settle predicate.
//!
//! The checks, in order:
//!   1. Is this tool's class in the **current state's allowed set**? (per-state scoping)
//!   2. For file-writes: is `target_path` under one of the state's `writable_dirs`?
//!      And NEVER `runlogs/` — the harness authors the record.
//!   3. Settle needs NO extra predicate: a `tier: settle` tool only ever runs IN Settle, which is
//!      reachable only by an uncontaminated cycle (the taint model). The old `allow_settle`
//!      whitelist+operator_signed reflex was removed — irreversibility is bounded by taint-
//!      reachability here + the custodial/wallet limits externally.
//!
//! Net effect: Perceive auto-denies all write/network-write; Express allows post/reply +
//! memory-append; Settle allows its registered settle-tier tools; everything else denied.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;

use super::classify::classify_tool;
use super::{ActionDecision, ActionRequest, ActionResponder};
use crate::config::CapabilityPrefix;
use crate::secrets::providers::SecretsBroker;
use crate::state::{ConsciousnessState, StateSpec, ToolClass};

/// One responder per invocation, bound to the running state's spec. Holding the spec
/// (not the state name) means the gate reads the exact same table the rest of the
/// harness does — there is no second, drifting copy of the policy.
pub struct StatePolicyResponder {
    pub spec: StateSpec,
    /// MCP capability prefixes treated as reversible capabilities (→ [`ToolClass::Post`]).
    pub post_tools: Vec<CapabilityPrefix>,
    /// MCP capability prefixes treated as irreversible authority (→ [`ToolClass::SettleTx`]).
    pub settle_tools: Vec<CapabilityPrefix>,
    /// MCP capability prefixes treated as monitoring/read capabilities (→ [`ToolClass::Read`]):
    /// registered `tier: read` servers (e.g. `mcp__cove-read__`). Safe in every state. Each may
    /// carry a `tools` allowlist the classifier enforces fail-closed.
    pub read_tools: Vec<CapabilityPrefix>,
    /// The soul-repo root, for relativizing the **absolute** `file_path`s the SDK emits
    /// before the `writable_dirs` prefix check. `None` in unit tests, which use
    /// repo-relative paths directly.
    pub repo_root: Option<PathBuf>,
    /// DRY-RUN block: tool-name PREFIXES denied here (testing). The agent composes the action — it's
    /// recorded — but the wall stops it executing. Tool-level so a no-trade run still allows
    /// `simulate_swap`/`get_*` while blocking `buy_token`. Empty ⇒ no dry-run blocking (live).
    pub dry_run_block: Vec<String>,
    /// May this cycle write LONG-TERM memory (`memory/`)? Set by the harness = cycle trust ≥
    /// `memory_write_min_trust` (org+). When `false`, a `memory/` write is denied (an untrusted in-run
    /// cycle leaves tags; the digest consolidates). `true` by default (tests / no restriction).
    pub long_term_writable: bool,
    /// Memory paths (repo-relative, e.g. `memory/INDEX.md`) that are PROTECTED: writable ONLY in Reflect,
    /// exactly like the soul's `prompts/`/`stimuli/`/`SOUL.md`. These files are engine-INJECTED into every
    /// context (the self-orientation block reads `memory/INDEX.md`), so letting a non-Reflect cycle — even
    /// an org+ digest/Express — rewrite them is a context-injection surface. Empty = none (default,
    /// back-compat). Set by the harness from `config.protected_memory_paths`; a plain file matches exactly,
    /// a `dir/` also matches anything beneath it.
    pub protected_paths: Vec<String>,
    /// Executable skills: the `<soul>/skills` root + the DIDs whose signature authorizes a manifest
    /// (operator + soul). A `RunSkillCommand` is verified against these; `None`/empty ⇒ skills are not
    /// enabled and every `RunSkillCommand` is denied. Set by the harness from the soul repo + identities.
    pub skills_root: Option<PathBuf>,
    pub trusted_signers: Vec<crate::identity::Did>,
    /// The trusted reply-SCOPE for this invocation (top-level stimulus/baton scalars: `conversation`,
    /// `in_reply_to`, …) — a skill command's `ref` args are filled from here, NEVER the model. Empty for a
    /// non-reply cycle. Set by the harness (`wall_for`) per invocation.
    pub reply_scope: std::collections::BTreeMap<String, String>,
    /// The secrets broker — used to MATERIALIZE a skill command's declared `secret` into the approved
    /// exec's `env` at call time (lazy: only when the command actually runs), so the credential reaches the
    /// skill process, never the model. `None` ⇒ a secret-bearing skill command is denied (no way to supply it).
    pub broker: Option<Arc<SecretsBroker>>,
    /// The harness-owned media dir — where a `produces: media` skill command writes its fetched image (the
    /// resolved `${MEDIA_OUT}`). `None` ⇒ a media-producing command is denied (nowhere safe to write). Set by
    /// the harness from `config.media_dir`; shared with the incoming-media store so the bridge reads it back.
    pub media_dir: Option<PathBuf>,
    /// The agent WORKSPACE roots (absolute; harness-owned, beside the soul). A file write under one is
    /// allowed in any state whose scope admits `FileWrite` (no `writable_dirs` entry needed — it is not the
    /// soul) but only when `workspace_writable`; a read under one is allowed and MARKS the invocation as
    /// having touched the workspace (the harness caps the cycle's trust after the step). Empty ⇒ no workspace.
    pub workspace_roots: Vec<PathBuf>,
    /// May this cycle WRITE into the workspace? `lattice.permits(cycle_trust, workspace.write_min_trust)`.
    pub workspace_writable: bool,
    /// Extra roots a builtin READ may target besides the soul and the workspace — the runtime's own spill
    /// dir (the SDK writes an oversized tool result to `~/.openclaude/projects/…/tool-results/` and the
    /// model reads it back; that is legitimate). Anything outside soul ∪ workspace ∪ these is denied.
    pub extra_read_roots: Vec<PathBuf>,
    /// Confine builtin file READS to soul ∪ workspace ∪ extra roots. On by the harness; off (`false`)
    /// only for unit tests without a repo root, where paths are soul-relative by construction.
    pub confine_reads: bool,
    /// Set when any allowed call targeted a workspace root this invocation (read OR write) — interior-mutable
    /// like `outward_seen`; the harness reads it after the step to apply `workspace.read_trust_cap`.
    workspace_touched: std::sync::atomic::AtomicBool,
    /// `(tool, input)` fingerprints of OUTWARD actions (Post / SettleTx) that ran this invocation —
    /// tracked so [`acted_outward`](Self::acted_outward) can gate the timeout-retry path (never re-run
    /// a wake that already posted/traded → no double-post on a re-run). Duplicates are NOT blocked: a
    /// verbatim repeat is usually a legitimate retry after a send glitch (the wall allowing a call is
    /// not the send succeeding), and irreversibility is bounded EXTERNALLY (chain nonce + provider
    /// limits), not by the wall. Per-invocation; interior-mutable because `decide` takes `&self`.
    outward_seen: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl StatePolicyResponder {
    /// A responder with no capability tools configured (reads/writes only). Used where
    /// the duty exposes no post/settle MCP tools.
    pub fn new(spec: StateSpec) -> Self {
        Self {
            spec,
            post_tools: Vec::new(),
            settle_tools: Vec::new(),
            read_tools: Vec::new(),
            repo_root: None,
            dry_run_block: Vec::new(),
            long_term_writable: true,
            protected_paths: Vec::new(),
            skills_root: None,
            trusted_signers: Vec::new(),
            reply_scope: Default::default(),
            broker: None,
            media_dir: None,
            workspace_roots: Vec::new(),
            workspace_writable: false,
            extra_read_roots: Vec::new(),
            confine_reads: false,
            workspace_touched: Default::default(),
            outward_seen: Default::default(),
        }
    }

    /// A responder aware of the deployment's capability MCP tools (operator config).
    pub fn with_capabilities(
        spec: StateSpec,
        post_tools: Vec<CapabilityPrefix>,
        settle_tools: Vec<CapabilityPrefix>,
    ) -> Self {
        Self {
            spec,
            post_tools,
            settle_tools,
            read_tools: Vec::new(),
            repo_root: None,
            dry_run_block: Vec::new(),
            long_term_writable: true,
            protected_paths: Vec::new(),
            skills_root: None,
            trusted_signers: Vec::new(),
            reply_scope: Default::default(),
            broker: None,
            media_dir: None,
            workspace_roots: Vec::new(),
            workspace_writable: false,
            extra_read_roots: Vec::new(),
            confine_reads: false,
            workspace_touched: Default::default(),
            outward_seen: Default::default(),
        }
    }

    /// Bind the agent workspace: the roots (absolute), whether THIS cycle may write there, and the extra
    /// read roots (the runtime's spill dir). Turns on read confinement: a builtin read must then target
    /// the soul, a workspace, or an extra root.
    pub fn with_workspace(mut self, roots: Vec<PathBuf>, writable: bool, extra_read_roots: Vec<PathBuf>) -> Self {
        self.workspace_roots = roots.into_iter().map(|r| normalize_lexical(&r)).collect();
        self.workspace_writable = writable;
        self.extra_read_roots = extra_read_roots.into_iter().map(|r| normalize_lexical(&r)).collect();
        self.confine_reads = true;
        self
    }

    /// Did any allowed call this invocation read or write under a workspace root?
    pub fn touched_workspace(&self) -> bool {
        self.workspace_touched.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Bind the soul-repo root so live (absolute) write targets are relativized against it
    /// before the `writable_dirs` check. The harness sets this to the canonical soul-repo path.
    pub fn with_repo_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.repo_root = Some(root.into());
        self
    }

    /// Enable executable skills: the `<soul>/skills` root + the DIDs (operator + soul) whose signature
    /// authorizes a manifest + the broker that materializes a command's declared secret. Without this, every
    /// `RunSkillCommand` is denied.
    pub fn with_skills(
        mut self,
        skills_root: impl Into<PathBuf>,
        trusted_signers: Vec<crate::identity::Did>,
        broker: Option<Arc<SecretsBroker>>,
    ) -> Self {
        self.skills_root = Some(skills_root.into());
        self.trusted_signers = trusted_signers;
        self.broker = broker;
        self
    }

    /// Bind the harness-owned media dir so a `produces: media` skill command can write its fetched image
    /// somewhere the bridge reads back (the resolved `${MEDIA_OUT}`). Without it, a media command is denied.
    pub fn with_media_dir(mut self, media_dir: impl Into<PathBuf>) -> Self {
        self.media_dir = Some(media_dir.into());
        self
    }

    /// Gate + build a `RunSkillCommand { skill, command, args }`: verify the manifest signature (the
    /// execute-gate), map the command's tier to a [`ToolClass`] and apply the SAME state-scope gate as any
    /// capability (so a `post` command runs only in Express, `settle` only in Settle — reachable only by an
    /// uncontaminated cycle), honor dry-run, then return the harness-built argv for the bridge to execve.
    /// Every failure is a Deny with a reason the model can act on.
    async fn decide_skill(&self, req: &ActionRequest) -> ActionDecision {
        let Some(skills_root) = &self.skills_root else {
            return ActionDecision::Deny("executable skills are not enabled for this deployment".into());
        };
        if self.trusted_signers.is_empty() {
            return ActionDecision::Deny("no trusted signer (operator/soul DID) configured — cannot authorize a skill".into());
        }
        // Parse the structured input: { skill, command, args: { name: value, … } }.
        let skill = req.input.get("skill").and_then(|v| v.as_str()).unwrap_or("");
        let command = req.input.get("command").and_then(|v| v.as_str()).unwrap_or("");
        if skill.is_empty() || command.is_empty() {
            return ActionDecision::Deny("RunSkillCommand needs `skill` and `command`".into());
        }
        let mut args = std::collections::BTreeMap::new();
        if let Some(obj) = req.input.get("args").and_then(|v| v.as_object()) {
            for (k, v) in obj {
                // Coerce scalars to string; reject a non-scalar arg (objects/arrays aren't valid argv values).
                let s = match v {
                    serde_json::Value::String(s) => s.clone(),
                    serde_json::Value::Number(n) => n.to_string(),
                    serde_json::Value::Bool(b) => b.to_string(),
                    _ => return ActionDecision::Deny(format!("RunSkillCommand arg `{k}` must be a scalar")),
                };
                args.insert(k.clone(), s);
            }
        }

        let trusted: Vec<&crate::identity::Did> = self.trusted_signers.iter().collect();
        let mut authz = match crate::skills::authorize(skills_root, skill, command, &args, &trusted, &self.reply_scope, self.media_dir.as_deref()) {
            Ok(a) => a,
            Err(e) => return ActionDecision::Deny(format!("skill `{skill}/{command}` denied: {e}")),
        };

        // The command's tier → a ToolClass, gated by the SAME per-state scope as any capability. This is the
        // taint gate: a `post` command needs Express (reachable only within the cycle's taint ceiling), a
        // `settle` command needs Settle (an uncontaminated cycle).
        let class = match authz.tier {
            crate::config::CapabilityTier::Read => ToolClass::Read,
            crate::config::CapabilityTier::Post => ToolClass::Post,
            crate::config::CapabilityTier::Settle => ToolClass::SettleTx,
        };
        if !self.spec.tool_scope.allows(class) {
            return ActionDecision::Deny(format!(
                "skill command `{skill}/{command}` is tier {:?} (class {class:?}) — not in {:?} scope",
                authz.tier, self.spec.state
            ));
        }

        // Dry-run: block by a synthetic id `RunSkillCommand:<skill>/<command>` so an operator can hold a
        // specific command (e.g. a real post) while letting reads through.
        let dry_id = format!("RunSkillCommand:{skill}/{command}");
        if self.dry_run_block.iter().any(|p| dry_id.starts_with(p.as_str())) {
            return ActionDecision::Deny(format!(
                "dry-run test mode: skill `{skill}/{command}` was recorded but intentionally NOT executed. \
                 This is expected — not a failure. Do not retry; treat it as done and continue."
            ));
        }

        // Materialize the command's declared secret via the broker (lazy — only now that it's approved) into
        // the exec's `env`, so the bridge injects it into the skill process. The value never touches the model
        // context. A missing broker or a materialization failure denies the call (fail-closed).
        if let Some(secret) = authz.exec.secret.clone() {
            let Some(broker) = &self.broker else {
                return ActionDecision::Deny(format!("skill `{skill}/{command}` needs secret `{secret}` but no secrets broker is configured"));
            };
            match broker.env_for(&[secret.clone()]).await {
                Ok(env) => authz.exec.env = env,
                Err(e) => return ActionDecision::Deny(format!("skill `{skill}/{command}`: secret `{secret}` unavailable: {e}")),
            }
        }

        // Record an outward skill action (post/settle) so `acted_outward()` guards the timeout-retry path.
        if matches!(class, ToolClass::Post | ToolClass::SettleTx) {
            self.outward_seen.lock().unwrap().insert(format!("skill\u{1}{}", authz.exec.argv.join("\u{1}")));
        }

        ActionDecision::AllowExec(authz.exec)
    }

    /// Did this invocation ALLOW any OUTWARD action (Post / SettleTx)? Reads the dedup set, which is
    /// populated only when an outward action passes every gate (scope + dry-run) and executes — so a
    /// dry-run-blocked or denied action does NOT count. The dispatch loop uses this to refuse to retry
    /// a timed-out wake that already had an irreversible/visible effect (no double-post on a re-run).
    pub fn acted_outward(&self) -> bool {
        !self.outward_seen.lock().unwrap().is_empty()
    }

    /// Write-gating: a file-write target must sit under a `writable_dirs` prefix and must
    /// never be `runlogs/`. The target is first **relativized** against the soul
    /// repo (file tools emit absolute paths, grounded vs OpenClaude 0.15.0) — anything that
    /// escapes the repo, or `..`-escapes one writable dir into another (e.g. `memory/../
    /// skills/`), is denied.
    fn write_target_allowed(&self, target: &str) -> bool {
        let Some(rel) = self.relativize(target) else {
            return false; // escaped the soul repo entirely
        };
        if rel.starts_with("runlogs/") {
            return false; // never — the record is harness-authored.
        }
        self.spec.writable_dirs.iter().any(|d| rel.starts_with(d))
    }

    /// Is this write target LONG-TERM memory (`memory/`)? Gated to org+ by `long_term_writable`.
    fn is_long_term_write(&self, target: &str) -> bool {
        self.relativize(target).is_some_and(|rel| rel.starts_with("memory/"))
    }

    /// Is this write target a PROTECTED memory path (Reflect-only)? A configured entry matches the
    /// relativized target exactly (a file) or as a directory prefix (`dir/…`). Relativization already
    /// collapses `..`, so `memory/../memory/INDEX.md` can't sneak past.
    fn is_protected_write(&self, target: &str) -> bool {
        let Some(rel) = self.relativize(target) else {
            return false;
        };
        self.protected_paths.iter().any(|p| {
            let p = p.trim_end_matches('/');
            rel == p || rel.starts_with(&format!("{p}/"))
        })
    }

    /// The absolute, `..`-collapsed form of a tool path (relative paths are soul-relative — the model's cwd).
    /// If the path (or its nearest existing ancestor) exists, it is canonicalized so a planted SYMLINK cannot
    /// point a read or write out of a root the lexical form appeared to be inside.
    fn absolutize(&self, target: &str) -> Option<PathBuf> {
        let t = Path::new(target);
        let abs = if t.is_absolute() {
            normalize_lexical(t)
        } else {
            normalize_lexical(&self.repo_root.as_ref()?.join(t))
        };
        Some(canonical_or_lexical(&abs))
    }

    /// Is `target` under one of the workspace roots? (`Some(root)` when it is.)
    fn workspace_root_of(&self, target: &str) -> Option<&PathBuf> {
        if self.workspace_roots.is_empty() {
            return None;
        }
        let abs = self.absolutize(target)?;
        self.workspace_roots.iter().find(|r| abs.starts_with(canonical_or_lexical(r)))
    }

    /// Read confinement: a builtin file read may target the soul, a workspace root, or an extra read root.
    /// Without a repo root (unit tests) a relative path is accepted; with one, anything else is outside.
    fn read_target_allowed(&self, target: &str) -> bool {
        if !self.confine_reads {
            return true;
        }
        let Some(abs) = self.absolutize(target) else {
            return Path::new(target).is_relative(); // no repo root: relative paths are soul-relative by construction
        };
        if let Some(root) = &self.repo_root {
            if abs.starts_with(canonical_or_lexical(&normalize_lexical(root))) {
                return true;
            }
        }
        if self.workspace_roots.iter().any(|r| abs.starts_with(canonical_or_lexical(r))) {
            return true;
        }
        self.extra_read_roots.iter().any(|r| abs.starts_with(canonical_or_lexical(r)))
    }

    fn mark_workspace_touched(&self) {
        self.workspace_touched.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// Resolve a write `target` to a **repo-relative, `..`-collapsed** path, or `None` if it
    /// escapes the soul repo. With a `repo_root`, an absolute target is relativized against
    /// it (and a `..`-escape above the root fails `strip_prefix`); without one (unit tests),
    /// the target is treated as repo-relative and any `..` component is rejected outright.
    fn relativize(&self, target: &str) -> Option<String> {
        let t = Path::new(target);
        match &self.repo_root {
            Some(root) => {
                let root = normalize_lexical(root);
                let abs = if t.is_absolute() {
                    normalize_lexical(t)
                } else {
                    normalize_lexical(&root.join(t))
                };
                let rel = abs.strip_prefix(&root).ok()?;
                Some(rel.to_string_lossy().replace('\\', "/"))
            }
            None => {
                if t.components().any(|c| c == Component::ParentDir) {
                    return None;
                }
                Some(normalize_lexical(t).to_string_lossy().replace('\\', "/"))
            }
        }
    }
}

#[async_trait]
impl ActionResponder for StatePolicyResponder {
    async fn decide(&self, req: &ActionRequest) -> ActionDecision {
        // (0a) `RunSkillCommand` is special: its class comes from the SIGNED manifest, not its name, so it's
        // gated on its own path (verify signature → tier → scope → build argv), returning the approved argv.
        if req.tool == crate::skills::RUN_SKILL_COMMAND {
            return self.decide_skill(req).await;
        }

        // (0) Derive the class + target path from the raw (tool, input) event. Unknown
        //     tools classify as `Other` → default-denied by the scope check.
        let (class, target_path) = classify_tool(
            &req.tool,
            &req.input,
            &self.settle_tools,
            &self.post_tools,
            &self.read_tools,
        );

        // (1) Per-state class scoping — the first and primary gate.
        if !self.spec.tool_scope.allows(class) {
            // The duck has a strong coding-agent prior: it tries to DELEGATE by calling an
            // `Agent`/`Task` tool. No such tool exists here (in-duck workers were removed 2026-10-13).
            // Teach the real mechanism — a brief to another agent over Buzz — instead of a bare denial.
            if is_delegation_tool(&req.tool) {
                return ActionDecision::Deny(format!(
                    "there is no `{}` tool for you — you do not spawn sub-agents. Delegation is a MESSAGE: \
                     post a crisp, self-contained brief to an agent on Buzz (Hermes/Jarvis in `research`, \
                     via the `buzz` tool in your express step) and fold in the result when it comes back \
                     in that channel. Do NOT keep searching for a delegation tool.",
                    req.tool
                ));
            }
            return ActionDecision::Deny(format!(
                "tool `{}` (class {:?}) not in {:?} scope",
                req.tool, class, self.spec.state
            ));
        }

        // (1.5) DRY-RUN (testing): the tool is in scope, but a dry-run block prefix says don't
        // EXECUTE it. The agent already composed the action (it's recorded in the runlog) — the wall
        // just stops it landing. Tool-level, so a no-real-trade run still lets `simulate_swap`/`get_*`
        // through while holding `buy_token`. One mechanism for every MCP (no per-server env).
        if self.dry_run_block.iter().any(|prefix| req.tool.starts_with(prefix)) {
            // It's a Deny (the SDK's canUseTool can't return a synthetic success — only allow/deny),
            // so the message must do the work: tell the model this is INTENTIONAL test mode, the
            // action was recorded, and NOT to retry — so it moves on instead of flailing.
            return ActionDecision::Deny(format!(
                "dry-run test mode: `{}` was recorded but intentionally NOT executed. This is \
                 expected — it is NOT a failure and NOT a permissions problem. Do not retry it; \
                 treat the action as already done and continue (or stop).",
                req.tool
            ));
        }

        // (1.7) Builtin file READS are confined to the soul ∪ the workspace ∪ the runtime's spill dir —
        // `../dack.config.yaml`, `/duck/secrets`, another agent's host path are not the duck's to read. A
        // read under the workspace is allowed and MARKS the invocation (the harness caps trust after the step).
        if class == ToolClass::Read && is_builtin_file_read(&req.tool) {
            if let Some(path) = &target_path {
                if self.workspace_root_of(path).is_some() {
                    self.mark_workspace_touched();
                } else if !self.read_target_allowed(path) {
                    return ActionDecision::Deny(format!(
                        "`{path}` is outside your tree — you may read your soul (your working dir){}; another \
                         machine's path, the harness config and its secrets are not yours to open.",
                        if self.workspace_roots.is_empty() { String::new() } else {
                            format!(" and your workspace ({})", self.workspace_roots.iter().map(|r| r.display().to_string()).collect::<Vec<_>>().join(", "))
                        }
                    ));
                }
            }
        }

        // (2) Write-gating: a file write must sit under the state's writable_dirs — or under the agent
        //     WORKSPACE (beside the soul; its own trust gate, see 2c).
        if class == ToolClass::FileWrite {
            // (2c) Workspace write: allowed in any state whose scope admits FileWrite (Perceive never does),
            // but only for a cycle trusted at least `workspace.write_min_trust` — a stranger's message must not
            // plant a file the duck will later read as its own. Marks the touch (the cap applies after).
            if let Some(path) = &target_path {
                if self.workspace_root_of(path).is_some() {
                    if !self.workspace_writable {
                        return ActionDecision::Deny(
                            "the workspace is writable only by a trusted (org+) cycle — this one isn't. \
                             Leave a note on your baton; do the write on a trusted wake."
                                .into(),
                        );
                    }
                    self.mark_workspace_touched();
                    return ActionDecision::Allow;
                }
            }
            match &target_path {
                Some(path) if self.write_target_allowed(path) => {
                    // (2a) Long-term memory gate: `memory/` is the duck's LONG-TERM memory, writable only
                    // by an org+ cycle (a digest job / reflect). A lower-trust in-run cycle leaves tags on
                    // its baton; the digest consolidates — so no laundered note lands in self-trust memory.
                    if !self.long_term_writable && self.is_long_term_write(path) {
                        return ActionDecision::Deny(
                            "`memory/` is your LONG-TERM memory — only a trusted (org+) cycle, a digest \
                             job, or reflect may write it. Don't write it here; leave a tag on your baton \
                             (and a tag-note) and the digest will consolidate it into memory."
                                .into(),
                        );
                    }
                    // (2b) Protected memory paths: engine-INJECTED memory files (e.g. `memory/INDEX.md`,
                    // which rides EVERY context) are self-modification surface, like prompts/stimuli/SOUL.md
                    // — writable ONLY in Reflect (the rate-limited, uncontaminated self-mod state). Even an
                    // org+ digest/Express is denied, so a trusted-but-not-Reflect cycle can't poison the
                    // always-present context.
                    if self.spec.state != ConsciousnessState::Reflect && self.is_protected_write(path) {
                        return ActionDecision::Deny(format!(
                            "`{}` is a PROTECTED memory file — it's injected into every context, so only \
                             Reflect may modify it (same rule as prompts/stimuli/SOUL.md). Not here: leave a \
                             tag-note and Reflect will fold it in.",
                            self.relativize(path).unwrap_or_else(|| path.to_string())
                        ));
                    }
                }
                Some(path) => {
                    return ActionDecision::Deny(format!(
                        "{:?} may not write `{path}`",
                        self.spec.state
                    ));
                }
                None => return ActionDecision::Deny("write with no target path".into()),
            }
        }

        // (2.5) Record OUTWARD actions (Post / SettleTx) so `acted_outward()` can gate the
        // timeout-retry path (never re-run a wake that already posted/traded → no double-post on a
        // re-run). We DO NOT block a verbatim-duplicate outward call. A repeat is usually a legitimate
        // RETRY after a send glitch — the wall ALLOWING a call is NOT the send SUCCEEDING (the MCP
        // result returns later, unseen here), so blocking a retry drops the real message AND misleads
        // the model into thinking it delivered (observed live: a reply to avanturismo silently lost).
        // The model is reliable (measured duplicate rate ~0.4%, single retries, no loops). Where an
        // irreversible/costly repeat genuinely must be prevented, that bound is EXTERNAL — the chain
        // rejects a replayed tx (nonce), the provider caps spend (cove hourly/daily limits) — not the
        // wall's job to guess intent. If you hold the key (the right state-prompt + access), you may
        // act, even identically; block it on-chain / at the provider, not here.
        if matches!(class, ToolClass::Post | ToolClass::SettleTx) {
            self.outward_seen
                .lock()
                .unwrap()
                .insert(format!("{}\u{1}{}", req.tool, req.input));
        }

        // (3) Irreversible authority needs NO extra runtime predicate (the `allow_settle`
        // whitelist+operator_signed reflex was removed — it was never wired). Being here means a
        // REGISTERED `tier: settle` capability is running IN Settle, and Settle is reachable only by
        // an UNCONTAMINATED cycle whose accumulated trust `reaches: settle` (the taint model). So
        // irreversibility is bounded UPSTREAM (taint-reachability + this state-scope gate + the
        // per-server tool allowlist) and EXTERNALLY (the custodial/wallet limits — cove daily caps /
        // no-withdraw, on-chain the wallet's native allowances). A settle-tier tool in Settle is
        // therefore allowed — it falls through to the final decision below.

        ActionDecision::Allow
    }
}

/// Is this an agent/subagent-spawning tool (the SDK `Task`, or the harness `Agent`)? Used only to
/// give a teaching deny when the duck reaches for one. Matches the bare tool name (any `mcp__…__`
/// prefix stripped), case-insensitive.
fn is_delegation_tool(tool: &str) -> bool {
    let bare = tool.rsplit("__").next().unwrap_or(tool);
    bare.eq_ignore_ascii_case("Agent") || bare.eq_ignore_ascii_case("Task")
}

/// A builtin FILE read (as opposed to an MCP read-tier tool or a non-file builtin like `ToolSearch`).
fn is_builtin_file_read(tool: &str) -> bool {
    matches!(tool, "Read" | "FileRead" | "Grep" | "Glob" | "LS" | "NotebookRead")
}

/// Canonicalize the path, or — if it does not exist yet (a write target) — its nearest existing ancestor
/// plus the remaining lexical tail; purely lexical when nothing exists. Follows symlinks on the existing
/// part, so a symlink planted inside a root cannot alias a path outside it.
fn canonical_or_lexical(p: &Path) -> PathBuf {
    if let Ok(c) = std::fs::canonicalize(p) {
        return c;
    }
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p.to_path_buf();
    while let Some(parent) = cur.parent() {
        if let Some(name) = cur.file_name() {
            tail.push(name.to_os_string());
        }
        if let Ok(c) = std::fs::canonicalize(parent) {
            let mut out = c;
            for t in tail.iter().rev() {
                out.push(t);
            }
            return out;
        }
        cur = parent.to_path_buf();
    }
    p.to_path_buf()
}

/// Lexically resolve `.`/`..` segments **without touching the filesystem** (a write target
/// may not exist yet, and we must not follow symlinks during a security check). `..` pops the
/// last kept component; `.` is dropped; roots/prefixes are kept.
fn normalize_lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{default_spec, ConsciousnessState};
    use serde_json::json;

    fn caps() -> (Vec<CapabilityPrefix>, Vec<CapabilityPrefix>) {
        (
            vec![CapabilityPrefix::open("mcp__twitter__")],  // post tools
            ["mcp__bankr__", "mcp__dac__", "mcp__cove-trading__"]
                .iter()
                .copied()
                .map(CapabilityPrefix::open)
                .collect(), // settle tools
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
    async fn long_term_memory_write_is_gated_by_trust() {
        // Express may write memory/ — but only when the cycle clears the long-term floor (org+).
        // A below-floor cycle (`long_term_writable = false`) is DENIED `memory/`; an org+ cycle is allowed.
        let (post, settle) = caps();
        let mut low = StatePolicyResponder::with_capabilities(default_spec(ConsciousnessState::Express), post.clone(), settle.clone());
        low.long_term_writable = false;
        assert!(matches!(
            low.decide(&req("Write", json!({"file_path": "memory/social.md", "contents": "x"}))).await,
            ActionDecision::Deny(d) if d.contains("LONG-TERM")
        ), "a below-floor cycle cannot write long-term memory");

        let mut ok = StatePolicyResponder::with_capabilities(default_spec(ConsciousnessState::Express), post, settle);
        ok.long_term_writable = true;
        assert!(matches!(
            ok.decide(&req("Write", json!({"file_path": "memory/social.md", "contents": "x"}))).await,
            ActionDecision::Allow
        ), "an org+ cycle (digest/reflect) writes long-term memory");
    }

    #[tokio::test]
    async fn protected_memory_paths_are_reflect_only() {
        // A protected memory file (e.g. INDEX.md, injected into EVERY context) is writable ONLY in Reflect —
        // even an org+ Express is denied. A non-protected memory file is unaffected. Covers Edit too.
        let mut expr = responder(ConsciousnessState::Express);
        expr.long_term_writable = true;
        expr.protected_paths = vec!["memory/INDEX.md".into()];
        assert!(matches!(
            expr.decide(&req("Write", json!({"file_path": "memory/social.md", "contents": "x"}))).await,
            ActionDecision::Allow
        ), "a NON-protected memory file is still writable by org+ Express");
        assert!(matches!(
            expr.decide(&req("Write", json!({"file_path": "memory/INDEX.md", "contents": "x"}))).await,
            ActionDecision::Deny(d) if d.contains("PROTECTED")
        ), "a protected memory file is denied outside Reflect");
        assert!(matches!(
            expr.decide(&req("Edit", json!({"file_path": "memory/INDEX.md", "old_string": "a", "new_string": "b"}))).await,
            ActionDecision::Deny(d) if d.contains("PROTECTED")
        ), "…and Edit can't bypass it (edit-family classifies as FileWrite)");

        let mut refl = responder(ConsciousnessState::Reflect);
        refl.long_term_writable = true;
        refl.protected_paths = vec!["memory/INDEX.md".into()];
        assert!(matches!(
            refl.decide(&req("Write", json!({"file_path": "memory/INDEX.md", "contents": "x"}))).await,
            ActionDecision::Allow
        ), "Reflect MAY modify a protected memory file (same rule as prompts/stimuli/SOUL.md)");
    }

    #[tokio::test]
    async fn snip_denied_for_every_duck_state() {
        // `snip` can delete the model's OWN grounding (the first user message / recall results — every user
        // message is snippable, no first-message protection), which caused a Reflect to trim its context
        // and confabulate. DENIED for every duck state (falls to `Other`).
        for state in [ConsciousnessState::Perceive, ConsciousnessState::Express, ConsciousnessState::Reflect] {
            let r = responder(state);
            assert!(matches!(
                r.decide(&req("snip", json!({"message_ids": ["ab12cd"]}))).await,
                ActionDecision::Deny(_)
            ), "{state:?} must NOT snip its own context");
        }
    }

    #[tokio::test]
    async fn parallel_prompt_cleared_writable_dirs_denies_memory() {
        // The P1 tie-in: a `parallel: true` prompt runs run_step with its `writable_dirs` CLEARED, so the
        // wall denies ANY memory/soul write — that's what makes the read-lock sound. A normal org+ Express
        // may still write memory.
        let mut normal = responder(ConsciousnessState::Express);
        normal.long_term_writable = true;
        assert!(matches!(
            normal.decide(&req("Write", json!({"file_path": "memory/social.md", "contents": "x"}))).await,
            ActionDecision::Allow
        ), "a NON-parallel org+ Express may write memory");

        let mut parallel = responder(ConsciousnessState::Express);
        parallel.long_term_writable = true;
        parallel.spec.writable_dirs.clear(); // what run_step does for `parallel: true`
        assert!(matches!(
            parallel.decide(&req("Write", json!({"file_path": "memory/social.md", "contents": "x"}))).await,
            ActionDecision::Deny(_)
        ), "a parallel cycle (writable_dirs cleared) can't write memory — the read-lock stays sound");
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
        // but cannot write soul dirs (FileWrite is in scope, the PATH is not).
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "skills/x/SKILL.md", "contents": "x"})))
                .await,
            ActionDecision::Deny(_)
        ));
        // and cannot run raw Bash (Shell never in scope).
        assert!(matches!(
            r.decide(&req("Bash", json!({"command": "curl evil"}))).await,
            ActionDecision::Deny(_)
        ));
    }

    /// Duplicate outward actions are ALLOWED: a verbatim repeat is usually a legit retry after a send
    /// glitch (blocking it drops the real message + misleads the model), and irreversibility is bounded
    /// externally (chain nonce + provider limits), not by the wall. The fingerprint is still recorded so
    /// `acted_outward()` keeps guarding the timeout-retry path.
    #[tokio::test]
    async fn duplicate_outward_action_is_allowed_but_records_acted_outward() {
        let r = responder(ConsciousnessState::Express);
        let post = req("mcp__twitter__post", json!({"text": "the harness blinked"}));
        // First time: allowed.
        assert!(matches!(r.decide(&post).await, ActionDecision::Allow));
        // Verbatim repeat: NOW allowed too (a retry, not a loop-block).
        assert!(matches!(r.decide(&post).await, ActionDecision::Allow));
        // A distinct post: allowed.
        assert!(matches!(
            r.decide(&req("mcp__twitter__post", json!({"text": "different thought"}))).await,
            ActionDecision::Allow
        ));
        // …but the outward action WAS recorded → the timeout-retry guard still refuses to re-run it.
        assert!(r.acted_outward(), "an allowed post flips acted_outward (no double-post on timeout re-run)");
    }

    /// `acted_outward` is the timeout-retry safety signal: it flips true ONLY once an outward action
    /// (Post / SettleTx) is actually allowed — a read or a memory write must NOT set it (those are safe
    /// to re-run after a hang).
    #[tokio::test]
    async fn acted_outward_flips_only_after_an_allowed_outward_action() {
        let r = responder(ConsciousnessState::Express);
        assert!(!r.acted_outward(), "clean before any action");
        // A memory write is not outward → still clean.
        let w = req("Write", json!({"file_path": "memory/log.md", "contents": "x"}));
        assert!(matches!(r.decide(&w).await, ActionDecision::Allow));
        assert!(!r.acted_outward(), "a memory write is not an outward action");
        // An allowed Post is outward → now flipped (so a later timeout won't be retried).
        let post = req("mcp__twitter__post", json!({"text": "hi"}));
        assert!(matches!(r.decide(&post).await, ActionDecision::Allow));
        assert!(r.acted_outward(), "an allowed post is an outward action");
    }

    /// The WORKSPACE (beside the soul): a write there is allowed in an act state for a trusted cycle, denied
    /// for an untrusted one, never in Perceive (no FileWrite in scope); a read there is allowed in every state
    /// and MARKS the invocation (the harness caps trust after the step).
    #[tokio::test]
    async fn workspace_write_needs_trust_and_any_touch_is_marked() {
        let ws = std::env::temp_dir().join(format!("dack-ws-wall-{}", std::process::id()));
        std::fs::create_dir_all(ws.join("inbox")).unwrap();
        let soul = std::env::temp_dir().join(format!("dack-soul-wall-{}", std::process::id()));
        std::fs::create_dir_all(&soul).unwrap();
        let (post, settle) = caps();
        let trusted = StatePolicyResponder::with_capabilities(default_spec(ConsciousnessState::Express), post.clone(), settle.clone())
            .with_repo_root(&soul)
            .with_workspace(vec![ws.clone()], true, vec![]);
        let draft = ws.join("outbox/draft.md").to_string_lossy().into_owned();
        assert!(matches!(trusted.decide(&req("Write", json!({"file_path": draft, "contents": "x"}))).await, ActionDecision::Allow));
        assert!(trusted.touched_workspace(), "a workspace write marks the touch");
        // the soul's own rules are untouched: memory/ still writable, skills/ still not
        assert!(matches!(trusted.decide(&req("Write", json!({"file_path": soul.join("memory/x.md").to_string_lossy(), "contents": "x"}))).await, ActionDecision::Allow));
        assert!(matches!(trusted.decide(&req("Write", json!({"file_path": soul.join("skills/x.md").to_string_lossy(), "contents": "x"}))).await, ActionDecision::Deny(_)));

        let untrusted = StatePolicyResponder::with_capabilities(default_spec(ConsciousnessState::Express), post.clone(), settle.clone())
            .with_repo_root(&soul)
            .with_workspace(vec![ws.clone()], false, vec![]);
        match untrusted.decide(&req("Write", json!({"file_path": draft, "contents": "x"}))).await {
            ActionDecision::Deny(m) => assert!(m.contains("trusted (org+)"), "{m}"),
            other => panic!("untrusted cycle must not write the workspace: {other:?}"),
        }
        assert!(!untrusted.touched_workspace(), "a DENIED write is not a touch");
        // reading is allowed regardless of write trust — and marks
        let inbox = ws.join("inbox/doc.md").to_string_lossy().into_owned();
        assert!(matches!(untrusted.decide(&req("Read", json!({"file_path": inbox}))).await, ActionDecision::Allow));
        assert!(untrusted.touched_workspace());

        // Perceive: read-only by scope — a workspace write is denied like any write, a read is fine
        let perceive = StatePolicyResponder::with_capabilities(default_spec(ConsciousnessState::Perceive), post, settle)
            .with_repo_root(&soul)
            .with_workspace(vec![ws.clone()], true, vec![]);
        assert!(matches!(perceive.decide(&req("Write", json!({"file_path": draft, "contents": "x"}))).await, ActionDecision::Deny(_)));
        assert!(matches!(perceive.decide(&req("Grep", json!({"pattern": "x", "path": ws.to_string_lossy()}))).await, ActionDecision::Allow));
        assert!(perceive.touched_workspace());
        let _ = std::fs::remove_dir_all(&ws);
        let _ = std::fs::remove_dir_all(&soul);
    }

    /// Builtin reads are CONFINED: the soul, the workspace and the runtime's spill dir are readable;
    /// the harness config, secrets, another machine's path and `/etc` are not. Relative paths stay
    /// soul-relative; a pathless Grep (cwd = soul) is untouched. Nothing marks the workspace.
    #[tokio::test]
    async fn builtin_reads_are_confined_to_soul_workspace_and_spill_dir() {
        let base = std::env::temp_dir().join(format!("dack-rd-{}", std::process::id()));
        let soul = base.join("dack-soul");
        let ws = base.join("workspace");
        let spill = base.join("home/.openclaude");
        for d in [&soul, &ws, &spill] {
            std::fs::create_dir_all(d).unwrap();
        }
        let (post, settle) = caps();
        let r = StatePolicyResponder::with_capabilities(default_spec(ConsciousnessState::Perceive), post, settle)
            .with_repo_root(&soul)
            .with_workspace(vec![ws.clone()], false, vec![spill.clone()]);
        let p = |x: &std::path::Path| x.to_string_lossy().into_owned();
        for ok in [p(&soul.join("memory/goals.md")), "memory/goals.md".to_string(), p(&spill.join("projects/x/tool-results/1.txt")), p(&ws.join("repos/a/README.md"))] {
            assert!(matches!(r.decide(&req("Read", json!({"file_path": ok}))).await, ActionDecision::Allow), "{ok} must be readable");
        }
        for bad in [p(&base.join("dack.config.yaml")), p(&base.join("secrets/buzz.key")), "/opt/data/looper-onboarding/docs/VERDICT.md".to_string(), "/etc/passwd".to_string(), "../dack.config.yaml".to_string()] {
            match r.decide(&req("Read", json!({"file_path": bad}))).await {
                ActionDecision::Deny(m) => assert!(m.contains("outside your tree"), "{bad}: {m}"),
                other => panic!("{bad} must be denied, got {other:?}"),
            }
        }
        assert!(matches!(r.decide(&req("Grep", json!({"pattern": "todo"}))).await, ActionDecision::Allow), "pathless grep runs in the soul");
        assert!(r.touched_workspace(), "the workspace read above marked the touch");
        // symlink escape: a link INSIDE the workspace pointing at the config is followed and refused
        #[cfg(unix)]
        {
            std::fs::write(base.join("dack.config.yaml"), "secret: 1").unwrap();
            std::os::unix::fs::symlink(base.join("dack.config.yaml"), ws.join("cfg.yaml")).unwrap();
            let r2 = StatePolicyResponder::new(default_spec(ConsciousnessState::Perceive)).with_repo_root(&soul).with_workspace(vec![ws.clone()], false, vec![]);
            assert!(matches!(r2.decide(&req("Read", json!({"file_path": p(&ws.join("cfg.yaml"))}))).await, ActionDecision::Deny(_)), "a symlink out of the workspace is followed and refused");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// When the duck reaches for an `Agent`/`Task` tool to delegate — the strong coding-agent prior —
    /// the deny doesn't just say "not in scope"; it teaches the real mechanism: a brief to a Buzz agent.
    #[tokio::test]
    async fn duck_agent_call_is_denied_with_buzz_delegation_guidance() {
        let r = responder(ConsciousnessState::Express);
        for tool in ["Agent", "Task", "mcp__whatever__Task"] {
            match r.decide(&req(tool, json!({"description": "build solution.py"}))).await {
                ActionDecision::Deny(m) => {
                    assert!(m.contains("Buzz"), "{tool}: deny should teach delegation over Buzz: {m}");
                    assert!(!m.contains("class Other"), "{tool}: should be the teaching deny, not the bare one: {m}");
                }
                other => panic!("{tool}: expected a teaching Deny, got {other:?}"),
            }
        }
        // A genuinely-unrelated out-of-scope tool still gets the plain scope deny (no delegation noise).
        match r.decide(&req("SomeRandomTool", json!({}))).await {
            ActionDecision::Deny(m) => assert!(!m.contains("Buzz"), "unrelated tool: {m}"),
            other => panic!("expected a Deny, got {other:?}"),
        }
    }

    /// Dry-run (testing): the wall denies the configured tool PREFIXES (composed, not executed) but
    /// leaves everything else — incl. reads and `simulate_swap` — alone. Tool-level, not class-level.
    #[tokio::test]
    async fn dry_run_block_denies_listed_prefixes_only() {
        let mut r = responder(ConsciousnessState::Express);
        r.dry_run_block = vec!["mcp__twitter__post".into(), "mcp__cove-trading__buy_token".into()];
        // A blocked outward tool → denied with a clear dry-run message (before the dedup guard).
        match r.decide(&req("mcp__twitter__post", json!({"text": "hi"}))).await {
            ActionDecision::Deny(m) => assert!(m.contains("dry-run"), "dry-run message: {m}"),
            other => panic!("expected dry-run Deny, got {other:?}"),
        }
        // A non-blocked tool (memory write) still passes — dry-run is tool-level, not a blanket halt.
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "memory/log.md", "contents": "x"})))
                .await,
            ActionDecision::Allow
        ));
        // A reply (not in the block list) still passes — only the listed prefixes are held.
        assert!(matches!(
            r.decide(&req("mcp__twitter__reply", json!({"text": "yo", "in_reply_to_tweet_id": "1"})))
                .await,
            ActionDecision::Allow
        ));
    }

    // ── RunSkillCommand: signed-manifest gating at the wall ──────────────────────────────────────

    /// Write a signed buzz pack (feed=read, publish_note=post) into a temp skills root and return
    /// `(skills_root, operator_did)`.
    fn signed_buzz_pack() -> (PathBuf, crate::identity::Did) {
        use crate::identity::ed25519::{ed25519_pub_to_did, encode_signature};
        use ed25519_dalek::{Signer, SigningKey};
        let op = SigningKey::from_bytes(&[3u8; 32]);
        let op_did = ed25519_pub_to_did(op.verifying_key().to_bytes());
        let root = std::env::temp_dir().join(format!("dack-wall-skill-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&root);
        let dir = root.join("buzz");
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = r#"
name: buzz
commands:
  - id: feed
    tier: read
    trust: public
    argv: ["${SKILL_DIR}/bin/buzz", "feed", "read", "--limit", "{limit}"]
    args: { limit: { type: enum, values: ["10","25"] } }
  - id: publish_note
    tier: post
    trust: self
    argv: ["${SKILL_DIR}/bin/buzz", "social", "publish", "note", "{text}"]
    args: { text: { type: string, pattern: "^.{1,280}$" } }
    secret: buzz_key
    network: true
"#;
        std::fs::write(dir.join("skill.manifest.yaml"), manifest).unwrap();
        std::fs::write(dir.join("skill.manifest.yaml.sig"), encode_signature(op.sign(manifest.as_bytes()).to_bytes())).unwrap();
        (root, op_did)
    }

    fn skill_req(skill: &str, command: &str, args: serde_json::Value) -> ActionRequest {
        req("RunSkillCommand", json!({ "skill": skill, "command": command, "args": args }))
    }

    /// A broker that materializes the `buzz_key` provider → `BUZZ_PRIVATE_KEY` from a test env var.
    fn test_broker() -> Arc<SecretsBroker> {
        std::env::set_var("BUZZ_PRIVATE_KEY", "nsec-test-secret");
        Arc::new(SecretsBroker::new_test(vec![Arc::new(
            crate::secrets::providers::StaticEnvProvider::new("buzz_key", vec!["BUZZ_PRIVATE_KEY".into()]),
        )]))
    }

    #[tokio::test]
    async fn skill_read_command_runs_in_perceive_and_builds_argv() {
        let (root, op_did) = signed_buzz_pack();
        let r = responder(ConsciousnessState::Perceive).with_skills(&root, vec![op_did], None);
        match r.decide(&skill_req("buzz", "feed", json!({ "limit": "10" }))).await {
            ActionDecision::AllowExec(spec) => {
                assert_eq!(spec.argv, vec![
                    format!("{}/buzz/bin/buzz", root.display()), "feed".into(), "read".into(), "--limit".into(), "10".into()
                ]);
                assert!(spec.secret.is_none());
                assert!(spec.env.is_empty()); // a no-secret command needs no injected env
            }
            other => panic!("expected AllowExec, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn skill_post_command_denied_in_perceive_allowed_in_express() {
        let (root, op_did) = signed_buzz_pack();
        // Perceive: a `post`-tier skill command is out of scope (the taint gate — reachable only in Express).
        let p = responder(ConsciousnessState::Perceive).with_skills(&root, vec![op_did.clone()], Some(test_broker()));
        assert!(matches!(
            p.decide(&skill_req("buzz", "publish_note", json!({ "text": "gm" }))).await,
            ActionDecision::Deny(d) if d.contains("not in") && d.contains("Perceive")
        ));
        // Express: allowed, and the declared secret is MATERIALIZED into `env` for the bridge to inject.
        let e = responder(ConsciousnessState::Express).with_skills(&root, vec![op_did.clone()], Some(test_broker()));
        match e.decide(&skill_req("buzz", "publish_note", json!({ "text": "gm frens" }))).await {
            ActionDecision::AllowExec(spec) => {
                assert_eq!(spec.argv.last().unwrap(), "gm frens");
                assert_eq!(spec.secret.as_deref(), Some("buzz_key"));
                assert_eq!(spec.env.get("BUZZ_PRIVATE_KEY").map(String::as_str), Some("nsec-test-secret")); // materialized
                assert!(spec.network);
                assert!(e.acted_outward(), "an allowed post-tier skill flips acted_outward");
            }
            other => panic!("expected AllowExec in Express, got {other:?}"),
        }
        // A post command WITHOUT a broker is denied (no way to supply its secret).
        let no_broker = responder(ConsciousnessState::Express).with_skills(&root, vec![op_did], None);
        assert!(matches!(
            no_broker.decide(&skill_req("buzz", "publish_note", json!({ "text": "hi" }))).await,
            ActionDecision::Deny(d) if d.contains("no secrets broker")
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn skill_denied_when_signature_missing_or_untrusted() {
        let (root, _op_did) = signed_buzz_pack();
        // A STRANGER DID as the only trusted signer → the operator-signed pack fails to verify → denied.
        use crate::identity::ed25519::ed25519_pub_to_did;
        use ed25519_dalek::SigningKey;
        let stranger = ed25519_pub_to_did(SigningKey::from_bytes(&[7u8; 32]).verifying_key().to_bytes());
        let r = responder(ConsciousnessState::Perceive).with_skills(&root, vec![stranger], None);
        assert!(matches!(
            r.decide(&skill_req("buzz", "feed", json!({ "limit": "10" }))).await,
            ActionDecision::Deny(d) if d.contains("denied")
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn skill_bad_args_and_traversal_are_denied() {
        let (root, op_did) = signed_buzz_pack();
        let r = responder(ConsciousnessState::Perceive).with_skills(&root, vec![op_did], None);
        // off-enum value → deny
        assert!(matches!(
            r.decide(&skill_req("buzz", "feed", json!({ "limit": "999" }))).await,
            ActionDecision::Deny(_)
        ));
        // unknown command → deny
        assert!(matches!(
            r.decide(&skill_req("buzz", "nope", json!({}))).await,
            ActionDecision::Deny(_)
        ));
        // skill-name traversal → deny (can't escape the skills root)
        assert!(matches!(
            r.decide(&skill_req("../../etc", "feed", json!({ "limit": "10" }))).await,
            ActionDecision::Deny(_)
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn skill_denied_when_skills_not_enabled() {
        // No with_skills() → RunSkillCommand is denied outright.
        let r = responder(ConsciousnessState::Express);
        assert!(matches!(
            r.decide(&skill_req("buzz", "feed", json!({ "limit": "10" }))).await,
            ActionDecision::Deny(d) if d.contains("not enabled")
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
        // but NEVER runlogs/ (harness authors the record).
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "runlogs/2026-05-30.md", "contents": "x"})))
                .await,
            ActionDecision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn settle_tier_tool_allowed_in_settle_by_tool_tier() {
        // A registered settle-tier tool, reached in Settle, is allowed — no extra predicate. The
        // bound is external (the funded cove balance + cove's own limits); reaching Settle required
        // an uncontaminated cycle (the taint model).
        let r = responder(ConsciousnessState::Settle);
        assert!(matches!(
            r.decide(&req("mcp__cove-trading__buy", json!({"token": "DOGE", "usd": "1"})))
                .await,
            ActionDecision::Allow
        ));
    }

    #[tokio::test]
    async fn read_server_allowlist_denies_offlist_tool() {
        // cove-read (read tier) serves a full surface incl. buy_token on the read-only token; its
        // `tools` allowlist holds it to read tools. In Perceive, a whitelisted read tool is allowed
        // (Read is in scope everywhere); a non-listed trade tool under the SAME prefix is denied
        // (fail-closed to Other) — it can NEVER ride the read tier into a reversible state.
        let mut r = responder(ConsciousnessState::Perceive);
        r.read_tools = vec![CapabilityPrefix {
            prefix: "mcp__cove-read__".into(),
            tools: vec!["get_balance".into(), "scan_trending_tokens".into()],
            banned_tools: vec![],
        }];
        assert!(matches!(
            r.decide(&req("mcp__cove-read__get_balance", json!({}))).await,
            ActionDecision::Allow
        ));
        assert!(matches!(
            r.decide(&req("mcp__cove-read__buy_token", json!({"token": "DOGE", "usd": "1"}))).await,
            ActionDecision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn settle_tier_tool_denied_outside_settle() {
        // The state gate: a settle-class tool in Express is denied by SCOPE (Express does not scope
        // SettleTx). (And the harness never even exposes a settle-tier MCP outside Settle.)
        let r = responder(ConsciousnessState::Express);
        assert!(matches!(
            r.decide(&req("mcp__cove-trading__buy", json!({"token": "DOGE", "usd": "1"})))
                .await,
            ActionDecision::Deny(_)
        ));
    }

    // ── live absolute-path relativization (the SDK emits absolute file_paths) ──

    #[tokio::test]
    async fn relativizes_absolute_paths_and_blocks_escapes() {
        let r = responder(ConsciousnessState::Express).with_repo_root("/repo");
        // The live case: an absolute memory path under the repo → allowed.
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "/repo/memory/log.md", "content": "x"})))
                .await,
            ActionDecision::Allow
        ));
        // Absolute soul-dir path → denied (Express may write only memory/).
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "/repo/skills/x/SKILL.md", "content": "x"})))
                .await,
            ActionDecision::Deny(_)
        ));
        // `..`-escape out of memory/ into skills/ → denied (the path the prefix check missed).
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "/repo/memory/../skills/x", "content": "x"})))
                .await,
            ActionDecision::Deny(_)
        ));
        // Outside the soul repo entirely → denied.
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "/etc/passwd", "content": "x"})))
                .await,
            ActionDecision::Deny(_)
        ));
        // runlogs/ never — even via an absolute path.
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "/repo/runlogs/2026-06.md", "content": "x"})))
                .await,
            ActionDecision::Deny(_)
        ));
    }

    #[tokio::test]
    async fn reflect_writes_soul_dirs_via_absolute_paths() {
        let r = responder(ConsciousnessState::Reflect).with_repo_root("/repo");
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "/repo/skills/new/SKILL.md", "content": "x"})))
                .await,
            ActionDecision::Allow
        ));
        // but a double `..` above the repo root is still denied.
        assert!(matches!(
            r.decide(&req("Write", json!({"file_path": "/repo/../../etc/x", "content": "x"})))
                .await,
            ActionDecision::Deny(_)
        ));
    }
}
