//! Operator config (PRD §8.2) — the non-LLM authority surface.
//!
//! A rich YAML the operator owns and the harness reads (hot-reloadable). Holds the trust lattice
//! (the taint model), the MCP registry + per-tier policy, secrets-provider refs, the reflect
//! rate-limit, forwarded-env *names*, secret *references* (never values), and the trusted operator
//! DID. The agent may *read* select fields (it should know it can be killed) but can **never
//! write** this — it is operator writer-of-record (PRD §7.1).

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{DackError, Result};
use crate::model::stimulus::TrustTier;
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

// The `(payload_tier, type)` routing table is GONE (TIER-4). The transition ceiling is now derived
// from the taint model (`TrustLattice::reaches`); `priority` + `coalesce` live in the stimulus
// frontmatter; the `entry` state-prompt is the stimulus's own `entry:`. Capability grants are the
// `tier_policy` handshake. Nothing remains to route by an agent-self-assigned `type`.

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
    /// The OPERATOR's model for this tier — the default model a state-prompt at this tier runs on.
    /// `None` falls back to the global `config.model`. (The model handshake, mirroring `mcp_whitelist`.)
    #[serde(default)]
    pub model: Option<String>,
    /// `false` (default) = the operator's `model` (or global) is fixed for this tier; a state-prompt's
    /// own `model:` is ignored. `true` = the soul may self-select a per-prompt `model:` (e.g. a Reflect
    /// tier the operator lets pick a stronger model). Operator boundary; soul self-selects within it.
    #[serde(default)]
    pub allow_model_override: bool,
}

impl Default for TierPolicy {
    /// The safe default for an unconfigured tier: **nothing grantable** — imports-only (locked) with
    /// an empty import list (least privilege; the operator must explicitly open a tier). Model: the
    /// global default, no soul override.
    fn default() -> Self {
        Self {
            mcp_whitelist: true,
            import: Vec::new(),
            deny: Vec::new(),
            model: None,
            allow_model_override: false,
        }
    }
}

fn default_true() -> bool {
    true
}

/// One tier in the operator-configured **trust lattice** (the taint/IFC model). A `name` plus the
/// highest consciousness state a cycle whose accumulated trust is this tier may walk to (`reaches`).
/// **Rank = position** in `DackConfig.trust_tiers` (low→high); the lattice is a total order.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustTierDef {
    pub name: String,
    /// State ceiling for a cycle at this tier. `public→express`, `org→settle`, `self→reflect`, …
    #[serde(default = "default_reaches")]
    pub reaches: ConsciousnessState,
}

fn default_reaches() -> ConsciousnessState {
    ConsciousnessState::Express
}

fn default_reflect_interval() -> i64 {
    86_400 // one day — a sane self-modification cadence; the operator may loosen or `0` to disable.
}

/// The resolved trust lattice — built from `DackConfig.trust_tiers` (or the safe default). A total
/// order by rank; the taint `meet` (greatest-lower-bound) is just the lower-ranked tier. An unknown
/// tier name fails SAFE (rank 0 / `reaches: express`) so a mislabel can never *raise* a ceiling.
#[derive(Debug, Clone)]
pub struct TrustLattice {
    tiers: Vec<TrustTierDef>, // index = rank
}

impl TrustLattice {
    /// Privilege rank (higher = more trusted). Unknown name → 0 (lowest), fail-safe.
    pub fn rank(&self, t: &TrustTier) -> usize {
        self.tiers.iter().position(|d| d.name == t.name()).unwrap_or(0)
    }
    /// The state ceiling a cycle at tier `t` may walk to. Unknown name → `Express` (safe).
    pub fn reaches(&self, t: &TrustTier) -> ConsciousnessState {
        self.tiers
            .iter()
            .find(|d| d.name == t.name())
            .map(|d| d.reaches)
            .unwrap_or(ConsciousnessState::Express)
    }
    /// The taint **meet**: the lower-trust (most-degraded) of two tiers. Monotonic down (I17).
    pub fn meet(&self, a: &TrustTier, b: &TrustTier) -> TrustTier {
        if self.rank(a) <= self.rank(b) {
            a.clone()
        } else {
            b.clone()
        }
    }
    pub fn contains(&self, name: &str) -> bool {
        self.tiers.iter().any(|d| d.name == name)
    }
}

/// The safe default lattice (when `trust_tiers:` is omitted) — reproduces the pre-taint behavior:
/// `public(→express) < self(→reflect) < operator_signed(→reflect)`.
fn default_trust_tiers() -> Vec<TrustTierDef> {
    use ConsciousnessState::*;
    vec![
        TrustTierDef { name: "public".into(), reaches: Express },
        TrustTierDef { name: "self".into(), reaches: Reflect },
        TrustTierDef { name: "operator_signed".into(), reaches: Reflect },
    ]
}

/// Lowercase-hex sha256 of `bytes` — the key into `signed_scripts` (operator code-review-as-signing).
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
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
    /// **Trust tier** of the data this secret puts in play (the taint model). A sensor using this
    /// provider seeds its cycle at (at most) this tier — e.g. the X bearer touches the public world
    /// so `trust: public` caps any twitter cycle at Express. Default `self` (the operator's own).
    #[serde(default = "default_self_trust")]
    pub trust: TrustTier,
}

fn default_self_trust() -> TrustTier {
    TrustTier::self_()
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
    /// Irreversible authority (trade/transfer/vote). Settle only — reachable only by an
    /// uncontaminated cycle (the taint model); externally bounded by the custodial/wallet limits.
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
    /// **Trust tier** of the data this server puts in play (the taint model — distinct from the
    /// capability `tier` above). Actually *calling* a tool from this server degrades the cycle's
    /// trust to (at most) this tier, capping how far the chain may then walk: e.g. `rootai`
    /// (3rd-party signals) `trust: public` → Express; `cove-read` (the operator's own wallet)
    /// `trust: self` → no degradation. Default `self`. A soul-inlined MCP isn't in this registry,
    /// so it taints **public** at access time (a soul can never self-grant trust).
    #[serde(default = "default_self_trust")]
    pub trust: TrustTier,
}

/// `dack.config.yaml` (PRD §8.2). Hot-reloadable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DackConfig {
    /// The trusted operator DID — provenance check for `operator_signed` (PRD §5.7).
    pub operator_did: String,
    /// The operator-configured **trust lattice** (the taint/IFC model). Ranked low→high; each tier
    /// declares the max state it `reaches`. Omit to use the safe default
    /// (`public→express < self→reflect < operator_signed→reflect`).
    #[serde(default = "default_trust_tiers")]
    pub trust_tiers: Vec<TrustTierDef>,
    /// **Operator-signed sensor scripts** (the taint seed, TIER-3): `sha256(source-hex) → trust`.
    /// A sensor whose source hashes to a listed entry seeds its cycle at that tier; an unsigned (or
    /// since-edited) script seeds `public`. This is operator code-review-as-signing — the agent
    /// authors a sensor, the operator reviews the EXACT bytes and signs the hash.
    #[serde(default)]
    pub signed_scripts: BTreeMap<String, TrustTier>,
    /// **Per-webhook trust** (TIER-3): a registered webhook path → the tier its payload is trusted
    /// at (e.g. an operator Telegram channel → `self`). An unlisted path seeds `public`.
    #[serde(default)]
    pub webhooks: BTreeMap<String, TrustTier>,
    /// **Reflect rate-limit** (TIER-4): the minimum seconds between self-modification (Reflect) runs,
    /// enforced by the harness clock for BOTH the scheduled Reflect and any transition-reached one —
    /// the rate-limit half of the I6 guarantee (the taint ceiling is the other half). `0` disables.
    /// Default 1 day.
    #[serde(default = "default_reflect_interval")]
    pub reflect_min_interval_secs: i64,
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
    /// (Settle only). MUST stay disjoint from `post_tools` (else a settle capability could classify
    /// as Post and run in Express). Settle is reachable only by an uncontaminated cycle (taint).
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
    /// → `ToolClass::SettleTx` (irreversible; Settle only).
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

    /// The resolved trust lattice (the taint model's order + state ceilings).
    pub fn lattice(&self) -> TrustLattice {
        TrustLattice { tiers: self.trust_tiers.clone() }
    }

    /// The trust seed for a sensor SCRIPT (TIER-3): the tier the operator signed its `sha256(source)`
    /// at, else `public` (an unsigned or since-edited script is untrusted code).
    pub fn script_trust(&self, source: &[u8]) -> TrustTier {
        self.signed_scripts
            .get(&sha256_hex(source))
            .cloned()
            .unwrap_or_else(TrustTier::public)
    }

    /// The trust seed for a webhook `path` (TIER-3): the operator-registered tier, else `public`.
    pub fn webhook_trust(&self, path: &str) -> TrustTier {
        self.webhooks.get(path).cloned().unwrap_or_else(TrustTier::public)
    }

    /// The trust label of a secrets provider by name (for the seed `meet`), or `self` if unknown.
    pub fn secret_trust(&self, name: &str) -> TrustTier {
        self.secrets_providers
            .iter()
            .find(|p| p.name == name)
            .map(|p| p.trust.clone())
            .unwrap_or_else(TrustTier::self_)
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
        Ok(())
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

}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
operator_did: "did:key:z6MkOperator"
forwarded_env: [TWITTER_API_KEY, BANKR_API_KEY, BUILDER_DID_KEY, DACK_HANDLE, RATE_LIMIT]
secrets:
  soul_did_key: "file:///run/secrets/soul_did_key"
"#;

    #[test]
    fn parses_sample_config() {
        let cfg = DackConfig::from_yaml(SAMPLE).expect("config parses");
        assert_eq!(cfg.operator_did, "did:key:z6MkOperator");
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
    fn trust_lattice_ranks_meets_and_reaches() {
        let cfg = DackConfig::from_yaml(
            "operator_did: \"x\"\ntrust_tiers:\n  - { name: public, reaches: express }\n  \
             - { name: org, reaches: settle }\n  - { name: self, reaches: reflect }\n  \
             - { name: operator_signed, reaches: reflect }\n",
        )
        .unwrap();
        let l = cfg.lattice();
        // Rank ascends with the list; meet (taint) returns the lower-trust tier.
        assert!(l.rank(&TrustTier::public()) < l.rank(&TrustTier::from("org")));
        assert!(l.rank(&TrustTier::from("org")) < l.rank(&TrustTier::self_()));
        assert_eq!(l.meet(&TrustTier::self_(), &TrustTier::public()), TrustTier::public());
        assert_eq!(l.meet(&TrustTier::from("org"), &TrustTier::self_()), TrustTier::from("org"));
        // Each tier's state ceiling.
        assert_eq!(l.reaches(&TrustTier::public()), ConsciousnessState::Express);
        assert_eq!(l.reaches(&TrustTier::from("org")), ConsciousnessState::Settle);
        assert_eq!(l.reaches(&TrustTier::self_()), ConsciousnessState::Reflect);
        // An unknown tier fails SAFE: rank 0 (lowest), reaches Express (never raises a ceiling).
        assert_eq!(l.rank(&TrustTier::from("bogus")), 0);
        assert_eq!(l.reaches(&TrustTier::from("bogus")), ConsciousnessState::Express);
        // The default lattice (no `trust_tiers:`) reproduces the pre-taint behavior.
        let d = DackConfig::from_yaml("operator_did: \"x\"").unwrap().lattice();
        assert_eq!(d.reaches(&TrustTier::self_()), ConsciousnessState::Reflect);
        assert_eq!(d.reaches(&TrustTier::public()), ConsciousnessState::Express);
    }

    #[test]
    fn seed_trust_from_signed_script_webhook_and_secret() {
        use sha2::{Digest, Sha256};
        let src = b"print('hi')\n";
        let hash: String = Sha256::digest(src).iter().map(|b| format!("{b:02x}")).collect();
        let yaml = format!(
            "operator_did: \"x\"\nsigned_scripts:\n  \"{hash}\": self\nwebhooks:\n  \"/telegram/op\": self\n\
             secrets_providers:\n  - {{ name: x, command: [echo], trust: public }}\n  - {{ name: cove, command: [echo], trust: self }}\n"
        );
        let cfg = DackConfig::from_yaml(&yaml).unwrap();
        // A SIGNED script's source hashes to its tier; an unsigned/edited script → public.
        assert_eq!(cfg.script_trust(src), TrustTier::self_());
        assert_eq!(cfg.script_trust(b"edited"), TrustTier::public());
        // A registered webhook path → its tier; an unknown path → public.
        assert_eq!(cfg.webhook_trust("/telegram/op"), TrustTier::self_());
        assert_eq!(cfg.webhook_trust("/random"), TrustTier::public());
        // Secret provider trust labels; an unknown provider → self (a no-op in the seed meet).
        assert_eq!(cfg.secret_trust("x"), TrustTier::public());
        assert_eq!(cfg.secret_trust("cove"), TrustTier::self_());
        assert_eq!(cfg.secret_trust("nope"), TrustTier::self_());
    }
}
