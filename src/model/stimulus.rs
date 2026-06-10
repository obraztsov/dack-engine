//! The `Stimulus` — inert event data until a consciousness state reasons about it
//! (architecture §3, PRD §5.6). This is the spine: a new source is just a new way
//! to mint one of these envelopes, and no envelope can *act* until digested behind
//! the firebreak. The harness is the sole writer-of-record (PRD §7.1); the agent
//! never sees the queue and never assigns its own tiers.

use serde::{Deserialize, Serialize};


/// Provenance-derived trust tier (PRD §5.7). Assigned *deterministically by the
/// source*, never by the model. The tier does not decide what the agent thinks
/// (cognition is sovereign); it decides — as a dumb edge rule in the bus — which
/// consciousness state a stimulus may route *toward*.
/// A trust-tier **name**. The lattice itself — which tiers exist, their rank, and the state each
/// `reaches` — is **operator-configured** ([`crate::config::TrustLattice`]), so this is a newtype
/// over the bare name (wire form: `public` / `self` / `operator_signed` / a custom `org`, …), not a
/// fixed enum. Equality is by name (`tier == TrustTier::public()`); ORDER + the state ceiling come
/// from the lattice (`lattice.rank` / `meet` / `reaches`), never from the type. The three
/// well-known names below MUST exist in every lattice (the default provides them).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TrustTier(pub String);

impl TrustTier {
    /// A tweet / a random webhook payload — the lowest default tier (read-only, always delimited
    /// untrusted). The default lattice maps it to a reversible `Express` ceiling.
    pub fn public() -> Self {
        Self("public".into())
    }
    /// The duck's own scheduled wakes / Reflect-authored directives — the clean baseline a cycle
    /// starts at. Default lattice: reaches `Reflect`.
    pub fn self_() -> Self {
        Self("self".into())
    }
    /// An RFC 9421 signature from the operator DID — the top tier (`dack say`). The only tier that
    /// the top tier (`dack say`); by default its cycles `reach` the whole ladder (PRD §5.7).
    pub fn operator() -> Self {
        Self("operator_signed".into())
    }
    pub fn name(&self) -> &str {
        &self.0
    }
}

impl From<&str> for TrustTier {
    fn from(s: &str) -> Self {
        TrustTier(s.to_string())
    }
}

/// Open vocabulary of stimulus types ("mention", "clarity_post", "scheduled_post",
/// "token_launch", …). A newtype rather than an enum so a Reflect-authored duty can
/// introduce a new type without a harness recompile (PRD §5).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct StimulusType(pub String);

impl From<&str> for StimulusType {
    fn from(s: &str) -> Self {
        StimulusType(s.to_string())
    }
}

impl std::fmt::Display for StimulusType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Stable id used for dedup and as a RunLog/runlog_ref anchor.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct StimulusId(pub String);

impl std::fmt::Display for StimulusId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Lifecycle of a row in the SQLite queue (PRD §5.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StimulusStatus {
    Pending,
    Coalesced,
    Dispatched,
    Done,
    Failed,
}

/// Semantic priority → numeric (PRD §5.6 "prioritize"). The agent may *influence*
/// priority (via the duty it authors in Reflect) but never sets it directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    Normal,
    High,
    Urgent,
}

impl Priority {
    /// Lower number = popped first by the single-flight queue.
    pub fn numeric(self) -> i32 {
        match self {
            Priority::Urgent => 0,
            Priority::High => 10,
            Priority::Normal => 20,
            Priority::Low => 30,
        }
    }
}

/// The `Stimulus` row (PRD §5.6). Carries **two independent trust levels** kept
/// separate end-to-end (PRD §5.3): the *directive* (the standing duty's `.md`,
/// trusted intent) and the *payload* (the sensor's view of the world, usually
/// untrusted). Conflating them would let a malicious tweet inherit the directive's
/// trust — so they are distinct fields, never merged.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stimulus {
    pub id: StimulusId,
    /// The stimulus *definition* id that produced this row, e.g. "clarity-reply-guy".
    pub source: String,
    #[serde(rename = "type")]
    pub type_: StimulusType,
    /// Trust tier of the `.md` directive (trusted intent): `self` | `operator_signed`.
    pub directive_tier: TrustTier,
    /// Trust tier of the sensor payload (the world): usually `public`.
    pub payload_tier: TrustTier,
    /// JSON; UNTRUSTED unless `payload_tier` says otherwise.
    pub payload: serde_json::Value,
    /// Signature / DID / cron-origin — evidence for the tiers.
    pub provenance: Option<String>,
    /// Unix epoch seconds.
    pub received_at: i64,
    /// Coalescing key (indexed in SQLite).
    pub dedup_key: Option<String>,
    pub priority: Priority,
    pub status: StimulusStatus,
    /// The trusted directive text (the `.md` body) carried alongside the untrusted
    /// payload. Delimited as trusted-briefing when assembled into Perceive context.
    pub directive_body: String,
    /// The **entry state-prompt id** this cycle opens at (MCP2-B) — the stimulus's own frontmatter
    /// `entry:` (e.g. `twitter/perceive_mention`), or the operator `default_entry` for synthesized
    /// stimuli. Dispatch resolves `prompts/<entry>.md`, runs it, then walks its `transitions`
    /// (each hop ceiling-clamped; the firebreak holds across every hop).
    pub entry: String,
}
