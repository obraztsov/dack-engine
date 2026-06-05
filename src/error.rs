//! Crate-wide error type. One enum, `?`-friendly across every module so the
//! harness can bubble failures into a RunLog entry (logging-not-rollback, PRD §7.5)
//! rather than crashing the single-flight loop.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum DackError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml::Error),

    /// Malformed config / control plane (PRD §8.2).
    #[error("config: {0}")]
    Config(String),

    /// A sensor violated the contract (PRD §5.2) or exited non-zero.
    #[error("sensor: {0}")]
    Sensor(String),

    /// The OpenClaude gRPC runtime seam (PRD §6).
    #[error("runtime: {0}")]
    Runtime(String),

    /// Repo-host adapter (Gitlawb / plain-git fallback, PRD §3.4).
    #[error("repo: {0}")]
    Repo(String),

    /// Identity-provider adapter (DID signing, PRD §3.3).
    #[error("identity: {0}")]
    Identity(String),

    /// A stimulus definition under `stimuli/` could not be parsed/registered (PRD §5.1).
    #[error("stimulus: {0}")]
    Stimulus(String),

    /// The embedded SQLite queue / durable store (PRD §5.6, §9.3).
    #[error("queue: {0}")]
    Queue(String),

    /// The `action_required` responder rejected a tool call (PRD §6.3) — this is
    /// a *normal* outcome (the wall doing its job), surfaced as an error only when
    /// a caller treated a denial as fatal.
    #[error("denied by responder: {0}")]
    Denied(String),

    #[error("not implemented (scaffold): {0}")]
    NotImplemented(&'static str),
}

pub type Result<T> = std::result::Result<T, DackError>;
