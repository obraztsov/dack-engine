//! Operator control plane + config (PRD §8.2) — the non-LLM authority surface.
//!
//! A rich YAML the operator owns and the harness reads (hot-reloadable). Holds the
//! routing table, the control plane (cap/whitelist — future), forwarded-env *names*,
//! secret *references* (names/paths, never values), and the trusted operator DID.
//! The agent may *read* select fields (it should know it can be killed) but can
//! **never write** this — it is operator writer-of-record (PRD §7.1).

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{DackError, Result};
use crate::model::stimulus::{Priority, StimulusType, TrustTier};
use crate::state::ConsciousnessState;

/// Coalescing policy — both an economics knob and a character decision (architecture §3).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoalescePolicy {
    pub mode: CoalesceMode,
    #[serde(default)]
    pub window_sec: Option<u64>,
    #[serde(default)]
    pub dedup_key: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoalesceMode {
    /// Batch within a window keyed by `dedup_key` (50 mentions → 1 wake).
    Batch,
    /// Keep only the latest per `dedup_key`.
    Latest,
    /// One-at-a-time; each candidate judged individually (e.g. token launches).
    None,
}

/// One routing rule: `(payload_tier, type)` → priority + coalesce + the transition **ceiling**.
/// Fixed states, configurable edges — the product-iteration surface. The agent never edits this and
/// never assigns its own tiers (PRD §5.6). The *entry* state-prompt is now the **stimulus's** own
/// frontmatter (`entry:`); this rule supplies the operator's dispatch concerns (MCP2-B).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingRule {
    #[serde(rename = "match")]
    pub match_: RouteMatch,
    /// The highest consciousness tier a chain matching this route may walk to (MCP2-B). The
    /// soul's state-prompt transitions are clamped to it; `ceiling: settle` is the operator
    /// authority that lets a self-tier trade duty reach Settle (what `PerceiveThenSettle` did).
    /// Defaults to reversible `Express` (Settle unreachable) when omitted. A `settle` ceiling is
    /// guarded at load to non-public routes (`validate_capabilities`). `Reflect` is never a ceiling.
    #[serde(default)]
    pub ceiling: Option<ConsciousnessState>,
    #[serde(default)]
    pub priority: Option<Priority>,
    #[serde(default)]
    pub coalesce: Option<CoalescePolicy>,
    /// Secrets-provider scopes the **act (Express/Settle) phase** of cycles matching this route
    /// may use (by provider `name`). **Operator-controlled** — the agent can't grant itself a
    /// secret; it can only select from the operator's `secrets_providers`. Materialized by the
    /// harness when opening Express; the read-only **Perceive never receives these** (PRD §7.2,
    /// §4.1; `docs/SECRETS-AND-SANDBOX.md`).
    #[serde(default)]
    pub secrets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteMatch {
    pub tier: TrustTier,
    #[serde(rename = "type")]
    pub type_: StimulusType,
}

/// Per-consciousness-tier MCP policy (MCP2-B, invariant I16) — the OPERATOR's half of the
/// capability handshake. A state-prompt's `mcp:` requests are admitted only by this policy:
/// - `import`: the operator-registered `mcp_servers` a state-prompt at this tier may import by name
///   (its token is injected server-side, never the agent context). The allowlist of secret-bearing
///   capabilities reachable here.
/// - `mcp_whitelist`: when `true` (the safe default, like Settle) ONLY `import` refs are allowed —
///   no self-plug. When `false` (an open tier, e.g. Perceive) the soul may ALSO inline ANY public,
///   secret-less MCP `{name,url}` (forced read-tier — a soul can never self-grant post/settle).
/// - `deny`: an explicit blocklist (belt-and-suspenders; a denied name is never admitted).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TierPolicy {
    /// `true` (default) = imports only (locked); `false` = the soul may also inline public read MCPs.
    #[serde(default = "default_true")]
    pub mcp_whitelist: bool,
    /// Operator-registered server names a state-prompt at this tier may import.
    #[serde(default)]
    pub import: Vec<String>,
    /// Server names never admitted at this tier (overrides `import` and inline).
    #[serde(default)]
    pub deny: Vec<String>,
}

impl Default for TierPolicy {
    /// The safe default for an unconfigured tier: **nothing grantable** — imports-only (locked) with
    /// an empty import list (least privilege; the operator must explicitly open a tier).
    fn default() -> Self {
        Self { mcp_whitelist: true, import: Vec::new(), deny: Vec::new() }
    }
}

fn default_true() -> bool {
    true
}

/// The control plane the Settle predicate reads (PRD §7.6, §8.2). v1: empty/zeroed —
/// no Settle wired. **Amount/cap is enforced by the DAC treasury, not duplicated here**
/// (PRD §7.6); `cap_remaining` is retained only as a future operator-visible field.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ControlPlane {
    #[serde(default)]
    pub cap_remaining: u64,
    /// Whitelisted contracts — set membership, the dumb half of `allow_settle`.
    #[serde(default)]
    pub whitelist: Vec<String>,
    #[serde(default)]
    pub allowed_action_types: Vec<String>,
}

/// One secrets provider (a trusted, harness-owned script) — see [`DackConfig::secrets_providers`].
/// The `command` is run with `env` (its config — e.g. creds-file/token-store paths) injected;
/// it prints a JSON object `{"ENV_KEY": "value", …}` on stdout that the harness injects into
/// the consumer that declared this provider's `name`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecretsProviderConfig {
    pub name: String,
    /// argv of the provider script, e.g. `["python3", "secrets-providers/x_oauth2.py"]`.
    pub command: Vec<String>,
    /// Config env passed to the script (paths/refs — NOT secret values).
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Env keys this provider is expected to emit (documentation / validation; optional).
    #[serde(default)]
    pub keys: Vec<String>,
}

/// Capability tier of an MCP server (PRD §4, §6.3) — maps its tools to a `ToolClass` and the
/// states that may reach them. The OPERATOR declares it; the agent can never change it (it would
/// be self-granting authority). This is the single source of truth the wall classifies from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityTier {
    /// Read-only (balances, prices, search). Safe in every state.
    Read,
    /// Reversible external effect (post/reply). Express only.
    Post,
    /// Irreversible authority (trade/transfer/vote). Settle only — additionally gated by
    /// `allow_settle` (whitelist + operator_signed). The most dangerous tier.
    Settle,
}

/// How an MCP capability server is reached.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpTransport {
    /// A remote streamable-HTTP MCP (e.g. `https://production.cove.trade/api/mcp`).
    Http { url: String },
    /// A locally-spawned stdio MCP (e.g. our own `twitter-mcp.ts`).
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
}

/// How the harness injects the materialized auth token into an MCP server — so the token reaches
/// the server but NEVER the agent's context (http: a request header; stdio: the server's env).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpAuth {
    /// Secrets-provider `name` whose materialized value is the token (operator-supplied).
    pub secret: String,
    /// Which env key the provider emits to use as the token. Defaults to the provider's sole key.
    #[serde(default)]
    pub key: Option<String>,
    /// HTTP: header name to set (default `Authorization`) with `scheme` (default `Bearer`).
    #[serde(default)]
    pub header: Option<String>,
    #[serde(default)]
    pub scheme: Option<String>,
    /// stdio: inject the token as this env var in the spawned server process.
    #[serde(default)]
    pub env: Option<String>,
}

/// An operator-declared MCP **capability server** (PRD §6.3). The registry is OPERATOR authority:
/// adding cove.trade, the next tool, … is a config entry — never a harness/bridge code change.
/// `tier` + the wall gate what its tools may do and which state reaches them.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Server name → tool prefix `mcp__<name>__`. The wall classifies by this prefix + `tier`.
    pub name: String,
    pub transport: McpTransport,
    #[serde(default)]
    pub auth: Option<McpAuth>,
    pub tier: CapabilityTier,
    /// Optional tool **allowlist** (bare names, e.g. `get_balance`). When non-empty, ONLY these
    /// tools are permitted from this server: the wall denies any other tool under its
    /// `mcp__<name>__` prefix **fail-closed** (PRD §6.3). This is how a single endpoint that
    /// exposes its full surface to every token (cove serves all 37 tools on the read-only token)
    /// is held to a read-only subset under `cove-read`, with the trade tools reachable only via
    /// the `cove-trading` (settle-tier) sibling. Empty = expose everything the server provides.
    #[serde(default)]
    pub tools: Vec<String>,
}

/// `dack.config.yaml` (PRD §8.2). Hot-reloadable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DackConfig {
    /// The trusted operator DID — provenance check for `operator_signed` (PRD §5.7).
    pub operator_did: String,
    #[serde(default)]
    pub routing: Vec<RoutingRule>,
    /// The state-prompt id harness-synthesized stimuli enter at (operator `dack say`, the
    /// boot back-online ping) — duties that carry no `entry:` of their own (MCP2-B). Defaults to
    /// the flat `perceive` prompt.
    #[serde(default = "default_entry_prompt")]
    pub default_entry: String,
    /// Per-consciousness-tier MCP policy (MCP2-B, invariant I16) — the operator's half of the
    /// capability handshake (which servers a state-prompt at each tier may import, and whether it
    /// may self-plug public read MCPs). An unconfigured tier defaults to locked + empty (nothing
    /// grantable). Keyed by `perceive`/`express`/`settle`/`reflect`.
    #[serde(default)]
    pub tier_policy: BTreeMap<ConsciousnessState, TierPolicy>,
    /// Names listed here are injected into the agent + sensor env. Reserved for
    /// recoverable/non-catastrophic values (API keys, handle, limits) — PRD §7.2.
    #[serde(default)]
    pub forwarded_env: Vec<String>,
    /// References only — values live in a separate secret store the YAML never inlines
    /// (so config is inspectable without exposing keys). The Soul DID key is here as a
    /// `file://` ref and is **never** forwarded to the agent (PRD §7.2, §8.2).
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
    /// **Secrets providers** — trusted, harness-owned scripts that materialize a short-lived
    /// token env on demand (fetch + validity-check + rotate-only-when-needed). A duty/skill
    /// references a provider by `name` in its `secrets:` list; the harness runs the provider
    /// command and injects its JSON output. Adding a new secret (X, cove.trade, …) is a YAML
    /// entry + a script — **never a harness change** (PRD §7.2; `docs/SECRETS-AND-SANDBOX.md`).
    #[serde(default)]
    pub secrets_providers: Vec<SecretsProviderConfig>,
    #[serde(default)]
    pub control_plane: ControlPlane,
    /// Cron schedule for the harness-entered Reflect run (PRD §4.2). `None` = manual
    /// (`dack reflect-now`) only.
    #[serde(default)]
    pub reflect_schedule: Option<String>,
    /// Path to the soul repo / actor bundle on the box (holds `stimuli/`, `SOUL.md`, …).
    #[serde(default = "default_soul_repo")]
    pub soul_repo: String,
    /// Embedded SQLite queue path (ephemeral; PRD §9.3). Losing it loses only the queue.
    #[serde(default = "default_db_path")]
    pub db_path: String,
    /// Localhost bind for the webhook listener (PRD §2 — nothing public without a proxy).
    #[serde(default = "default_webhook_addr")]
    pub webhook_addr: String,
    /// Path to the `openclaude-bridge/` project the runtime runs (`bun run bridge.ts`) —
    /// the TS side of the runtime seam (depends on `@gitlawb/openclaude` from npm).
    #[serde(default = "default_bridge_dir")]
    pub bridge_dir: String,
    /// Model id passed to the engine as `options.model` — only for models in the SDK's own
    /// catalog (Anthropic tiers). **For an OpenAI-compatible gateway (opengateway/mimo,
    /// Ollama, …) leave this `None` and set `OPENAI_MODEL` via `runtime_env`** — the SDK
    /// resolves `options.model` against its catalog and rejects unknown gateway names
    /// (live-verified, Phase 4).
    #[serde(default)]
    pub model: Option<String>,
    /// Env var *names* forwarded into the runtime bridge — the provider key, base URL, and
    /// model name live here (values come from the harness env, never the YAML). **Soul key
    /// never listed.**
    #[serde(default = "default_runtime_env")]
    pub runtime_env: Vec<String>,
    /// `gl` identity **directories** per role (each holds `identity.pem` + `ucan.json`). The
    /// Soul dir signs soul commits/pushes and **never enters agent env** (PRD §3.3, §7.2).
    #[serde(default)]
    pub identities: IdentityDirs,
    /// The soul repo's signed push remote, e.g. `gitlawb://<soul-did>/dack-soul`. When set
    /// (with `identities.soul`), the harness uses the Gitlawb repo-host (signed `gitlawb://`
    /// push); otherwise plain-git degraded mode (PRD §3.5). `None` = local-only / offline.
    #[serde(default)]
    pub soul_remote: Option<String>,
    /// The gitlawb node the signed push targets (`GITLAWB_NODE`).
    #[serde(default = "default_gitlawb_node")]
    pub gitlawb_node: String,
    /// Wall-clock budget (seconds) for one consciousness invocation, incl. the wall round-trips.
    /// A hung LLM/bridge elapses here rather than freezing the single-flight loop (PRD §11.8).
    #[serde(default = "default_invoke_timeout_secs")]
    pub invoke_timeout_secs: u64,
    /// MCP tool-name **prefixes** the wall treats as REVERSIBLE capabilities → `ToolClass::Post`
    /// (allowed in Express). The duck's act-phase tools, e.g. `mcp__twitter__` (post/reply).
    #[serde(default = "default_post_tools")]
    pub post_tools: Vec<String>,
    /// MCP tool-name **prefixes** the wall treats as IRREVERSIBLE authority → `ToolClass::SettleTx`
    /// (Settle only, additionally gated by `allow_settle`). MUST stay disjoint from `post_tools`
    /// (else a settle capability could classify as Post and run in Express). v1 Settle is unreachable.
    #[serde(default = "default_settle_tools")]
    pub settle_tools: Vec<String>,
    /// **MCP capability registry** (PRD §6.3) — operator-declared servers the duck can use in its
    /// act phases. Each server's `tier` derives the wall's classification (so declaring a server
    /// `tier: settle` makes its tools Settle-only); routes grant them via `capabilities:`. Adding
    /// a new tool (cove.trade, …) is an entry here + a token — never a harness/bridge code change.
    #[serde(default)]
    pub mcp_servers: Vec<McpServerConfig>,
}

/// One capability tool prefix the wall classifies by, plus its optional per-server tool allowlist.
/// `prefix` is `mcp__<server>__` (or an explicit `post_tools`/`settle_tools` entry); `tools` is the
/// server's bare-name allowlist (empty = all tools of that prefix are in-class).
#[derive(Debug, Clone)]
pub struct CapabilityPrefix {
    pub prefix: String,
    pub tools: Vec<String>,
}

impl CapabilityPrefix {
    /// A prefix with no tool allowlist (explicit `post_tools`/`settle_tools` entries, or a server
    /// that exposes its full surface).
    pub fn open(prefix: impl Into<String>) -> Self {
        Self { prefix: prefix.into(), tools: Vec::new() }
    }
}

/// The wall's capability tool-prefix classification (PRD §6.3), derived from the MCP registry
/// tiers merged with the explicit `post_tools`/`settle_tools`. Single source of truth.
#[derive(Debug, Clone, Default)]
pub struct CapabilityPrefixes {
    /// → `ToolClass::Read` (monitoring MCPs; safe everywhere).
    pub read: Vec<CapabilityPrefix>,
    /// → `ToolClass::Post` (reversible; Express).
    pub post: Vec<CapabilityPrefix>,
    /// → `ToolClass::SettleTx` (irreversible; Settle + `allow_settle`).
    pub settle: Vec<CapabilityPrefix>,
}

/// `gl` identity directories per liability-boundary role (PRD §3.3). Each is a path to a dir
/// holding `identity.pem` (+ `ucan.json`). All optional: unset roles are simply absent (the
/// harness falls back where it can). The Soul key is harness-only — never forwarded.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IdentityDirs {
    #[serde(default)]
    pub soul: Option<String>,
    #[serde(default)]
    pub operator: Option<String>,
    #[serde(default)]
    pub builder: Option<String>,
}

fn default_entry_prompt() -> String {
    "perceive".to_string()
}
fn default_soul_repo() -> String {
    ".".to_string()
}
fn default_db_path() -> String {
    "dack.sqlite".to_string()
}
fn default_webhook_addr() -> String {
    "127.0.0.1:8787".to_string()
}
fn default_bridge_dir() -> String {
    "openclaude-bridge".to_string()
}
fn default_gitlawb_node() -> String {
    "https://node.gitlawb.com".to_string()
}
fn default_invoke_timeout_secs() -> u64 {
    300
}
fn default_post_tools() -> Vec<String> {
    vec!["mcp__twitter__".to_string()]
}
fn default_settle_tools() -> Vec<String> {
    vec!["mcp__bankr__".to_string(), "mcp__dac__".to_string()]
}
fn default_runtime_env() -> Vec<String> {
    vec![
        "OPENAI_API_KEY".to_string(),
        "OPENAI_BASE_URL".to_string(),
        "OPENAI_MODEL".to_string(),
    ]
}

impl DackConfig {
    pub fn load(path: impl AsRef<Path>) -> Result<Self> {
        let text = std::fs::read_to_string(path)?;
        Self::from_yaml(&text)
    }

    pub fn from_yaml(text: &str) -> Result<Self> {
        serde_yaml::from_str(text).map_err(DackError::from)
    }

    /// Look up an MCP capability server by name.
    pub fn mcp_server(&self, name: &str) -> Option<&McpServerConfig> {
        self.mcp_servers.iter().find(|s| s.name == name)
    }

    /// The wall's capability prefix→class map (PRD §6.3): registry tiers (`mcp__<name>__`) merged
    /// with the explicit `post_tools`/`settle_tools`. The single source of truth the responder
    /// classifies from — so declaring a server `tier: settle` is what makes its tools Settle-only.
    pub fn capability_prefixes(&self) -> CapabilityPrefixes {
        let mut p = CapabilityPrefixes {
            read: Vec::new(),
            post: self.post_tools.iter().map(CapabilityPrefix::open).collect(),
            settle: self.settle_tools.iter().map(CapabilityPrefix::open).collect(),
        };
        for s in &self.mcp_servers {
            let cp = CapabilityPrefix {
                prefix: format!("mcp__{}__", s.name),
                tools: s.tools.clone(),
            };
            match s.tier {
                CapabilityTier::Read => p.read.push(cp),
                CapabilityTier::Post => p.post.push(cp),
                CapabilityTier::Settle => p.settle.push(cp),
            }
        }
        p
    }

    /// Startup safety check (PRD §6.3): a settle (irreversible) capability prefix must NEVER be a
    /// prefix-of / prefixed-by a reversible (post) or read prefix — else a settle tool could
    /// classify as `Post`/`Read` and run outside Settle. Checks the FULL derived map (registry +
    /// explicit lists). Called once at boot; a violation is a hard config error.
    pub fn validate_capabilities(&self) -> Result<()> {
        let p = self.capability_prefixes();
        let overlaps = |a: &str, b: &str| a.starts_with(b) || b.starts_with(a);
        for s in &p.settle {
            for other in p.post.iter().chain(p.read.iter()) {
                if overlaps(&s.prefix, &other.prefix) {
                    return Err(DackError::Config(format!(
                        "capability prefixes overlap: settle `{}` vs `{}` — must be disjoint \
                         (an irreversible tool must never classify as Post/Read and escape Settle)",
                        s.prefix, other.prefix
                    )));
                }
            }
        }
        // Route-ceiling guards (MCP2-B): `Reflect` is harness-only and never a ceiling; and an
        // irreversible `Settle` ceiling may be declared ONLY on a non-public route (a self/operator
        // duty) — an untrusted public payload can never be walked to Settle even by operator typo.
        for r in &self.routing {
            match r.ceiling {
                Some(ConsciousnessState::Reflect) => {
                    return Err(DackError::Config(format!(
                        "route {:?}/{:?}: `ceiling: reflect` is invalid — Reflect is harness-entered only",
                        r.match_.tier, r.match_.type_
                    )));
                }
                Some(ConsciousnessState::Settle)
                    if r.match_.tier.rank() < TrustTier::SelfTier.rank() =>
                {
                    return Err(DackError::Config(format!(
                        "route {:?}/{:?}: `ceiling: settle` requires a self/operator_signed route \
                         — an untrusted ({:?}) payload may never reach the irreversible Settle",
                        r.match_.tier, r.match_.type_, r.match_.tier
                    )));
                }
                _ => {}
            }
        }
        Ok(())
    }

    /// The transition ceiling for a `(tier, type)` route (MCP2-B) — the highest consciousness tier a
    /// matching chain may walk to. Defaults to reversible **Express** when the route omits `ceiling`
    /// or no route matches (Settle is never reachable without an explicit operator opt-in).
    pub fn ceiling_for(&self, tier: TrustTier, type_: &StimulusType) -> ConsciousnessState {
        self.lookup_route(tier, type_)
            .and_then(|r| r.ceiling)
            .unwrap_or(ConsciousnessState::Express)
    }

    /// The MCP [`TierPolicy`] for a consciousness `state` (MCP2-B) — the operator's half of the
    /// capability handshake. An unconfigured tier returns the safe default (locked, nothing
    /// grantable). Borrowed from the map when present, else a static default.
    pub fn tier_policy_for(&self, state: ConsciousnessState) -> std::borrow::Cow<'_, TierPolicy> {
        match self.tier_policy.get(&state) {
            Some(p) => std::borrow::Cow::Borrowed(p),
            None => std::borrow::Cow::Owned(TierPolicy::default()),
        }
    }

    /// The configured `gl` identity dirs keyed by role — fed to
    /// [`GitlawbIdentity::resolve`](crate::identity::gitlawb::GitlawbIdentity::resolve) so the
    /// harness can sign as the Soul (and, later, verify operator_signed via the Operator DID).
    pub fn identity_dirs(
        &self,
    ) -> std::collections::HashMap<crate::identity::IdentityRole, std::path::PathBuf> {
        use crate::identity::IdentityRole::*;
        let mut m = std::collections::HashMap::new();
        if let Some(d) = &self.identities.soul {
            m.insert(Soul, d.into());
        }
        if let Some(d) = &self.identities.operator {
            m.insert(Operator, d.into());
        }
        if let Some(d) = &self.identities.builder {
            m.insert(Builder, d.into());
        }
        m
    }

    /// Look up the routing rule for a `(payload_tier, type)` pair. Returns the first
    /// match (operator authoring order is significant).
    pub fn lookup_route(&self, tier: TrustTier, type_: &StimulusType) -> Option<&RoutingRule> {
        self.routing
            .iter()
            .find(|r| r.match_.tier == tier && &r.match_.type_ == type_)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
operator_did: "did:key:z6MkOperator"
routing:
  - match: { tier: public, type: mention }
    priority: low
    coalesce: { mode: batch, window_sec: 300, dedup_key: thread_id }
  - match: { tier: self, type: scheduled_post }
    ceiling: express
forwarded_env: [TWITTER_API_KEY, BANKR_API_KEY, BUILDER_DID_KEY, DACK_HANDLE, RATE_LIMIT]
secrets:
  soul_did_key: "file:///run/secrets/soul_did_key"
control_plane:
  cap_remaining: 0
  whitelist: []
  allowed_action_types: []
"#;

    #[test]
    fn parses_sample_config() {
        let cfg = DackConfig::from_yaml(SAMPLE).expect("config parses");
        assert_eq!(cfg.operator_did, "did:key:z6MkOperator");
        assert_eq!(cfg.routing.len(), 2);
        assert!(cfg.forwarded_env.contains(&"TWITTER_API_KEY".to_string()));
        // Soul key is a reference, never forwarded.
        assert!(cfg.secrets.contains_key("soul_did_key"));
        assert!(!cfg.forwarded_env.contains(&"SOUL_DID_KEY".to_string()));
    }

    #[test]
    fn validate_capabilities_rejects_overlapping_prefixes() {
        let mut cfg = DackConfig::from_yaml(SAMPLE).unwrap();
        // Defaults (mcp__twitter__ vs mcp__bankr__/mcp__dac__) are disjoint.
        assert!(cfg.validate_capabilities().is_ok());
        // A post prefix that swallows a settle prefix is rejected (settle would classify as Post).
        cfg.post_tools = vec!["mcp__".into()];
        cfg.settle_tools = vec!["mcp__bankr__".into()];
        assert!(cfg.validate_capabilities().is_err());
    }

    #[test]
    fn route_ceiling_defaults_to_express_and_guards_settle() {
        let cfg = DackConfig::from_yaml(SAMPLE).unwrap();
        // A public mention route with no explicit ceiling → reversible Express (never Settle).
        assert_eq!(
            cfg.ceiling_for(TrustTier::Public, &StimulusType::from("mention")),
            ConsciousnessState::Express
        );
        // An unmatched (tier,type) also defaults to Express.
        assert_eq!(
            cfg.ceiling_for(TrustTier::Public, &StimulusType::from("token_launch")),
            ConsciousnessState::Express
        );
        // A `ceiling: settle` on a PUBLIC route is rejected at validation (untrusted → never Settle).
        let bad = "operator_did: \"x\"\nrouting:\n  - match: { tier: public, type: mention }\n    ceiling: settle\n";
        assert!(DackConfig::from_yaml(bad).unwrap().validate_capabilities().is_err());
        // The same ceiling on a self-tier route is allowed (the trade-duty case).
        let ok = "operator_did: \"x\"\nrouting:\n  - match: { tier: self, type: trade_signal }\n    ceiling: settle\n";
        let okc = DackConfig::from_yaml(ok).unwrap();
        assert!(okc.validate_capabilities().is_ok());
        assert_eq!(
            okc.ceiling_for(TrustTier::SelfTier, &StimulusType::from("trade_signal")),
            ConsciousnessState::Settle
        );
    }
}
