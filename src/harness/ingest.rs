//! The ingestion pipeline (PRD §5.5 steps 1–5; architecture §3 layers 1–2) — the **dumb,
//! pre-conscious half** of the harness: sources → sensor → bus → queue. A fired trigger
//! runs the duty's sensor (or, for a pure-cron self-prompt, synthesizes one candidate),
//! and the bus normalizes/coalesces/enqueues. **No reasoning here** (architecture §1); the
//! consciousness loop that *pops* the queue and invokes the runtime is Phase 4 (held).
//!
//! Everything an attacker-influenced byte touches in this file is **data** (sensor stdout,
//! webhook body), never an instruction — the firebreak sits downstream, at Perceive.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use chrono::Utc;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc;

use crate::bus::Bus;
use crate::config::DackConfig;
use crate::error::{DackError, Result};
use crate::model::stimulus::StimulusId;
use crate::secrets::providers::SecretsBroker;
use crate::sensor::{SensorCandidate, SensorRunner};
use crate::sources::{CronScheduler, FiredTrigger};
use crate::stimuli::Registry;
use crate::webserver::WebhookListener;

/// Per-sensor wall-clock budget (PRD §5.2 "bounded by `timeout`").
const SENSOR_TIMEOUT: Duration = Duration::from_secs(30);

/// Owns the ingestion seams. The `registry` is behind an `RwLock` so the hot-reload watcher
/// can swap it under a running drain loop without a restart (PRD §5.1).
pub struct Ingestor {
    pub repo_root: PathBuf,
    pub config: Arc<DackConfig>,
    pub queue: Arc<dyn crate::queue::Queue>,
    pub bus: Arc<Bus>,
    pub sensor: Arc<dyn SensorRunner>,
    pub registry: Arc<RwLock<Registry>>,
    /// Materializes the short-lived secret env a duty declares (the trusted provider scripts).
    pub broker: Arc<SecretsBroker>,
}

impl Ingestor {
    /// Handle one fired trigger end-to-end. Pure of timers (the caller supplies `now`), so
    /// it is the deterministic seam the acceptance test drives directly.
    pub async fn process(&self, fired: FiredTrigger, now: i64) -> Result<Vec<StimulusId>> {
        // Snapshot the def out of the registry so we never hold the lock across an `.await`.
        let def = {
            let reg = self.registry.read().unwrap();
            reg.get(&fired.def_id).cloned()
        };
        let Some(def) = def else {
            // Duty vanished between firing and handling (a hot-reload race) — drop quietly.
            return Ok(vec![]);
        };

        let candidates = match def.resolved_sensor(&self.repo_root) {
            // A duty with a (trusted) sensor: run it on the trigger payload.
            Some(exe) => {
                // Base read-scoped env + the short-lived token env the duty's declared
                // providers materialize (the harness runs those trusted scripts; the sensor
                // only ever sees the resulting bearer — PRD §7.2).
                let mut env = self.sensor_env();
                for (k, v) in self.broker.env_for(&def.frontmatter.secrets).await? {
                    env.insert(k, v);
                }
                self.sensor
                    .run(&exe, &fired.payload, &env, SENSOR_TIMEOUT)
                    .await?
            }
            // Pure-cron self-prompt (the duck's alarm clock, PRD §10.3): no sensor, so
            // synthesize one candidate carrying the duty's own emits type. The *content* is
            // the trusted directive body, attached by the bus; the payload is empty.
            None => vec![SensorCandidate {
                type_: def.frontmatter.emits.type_.clone(),
                payload: serde_json::json!({}),
                dedup_key: None,
                payload_tier: None,
            }],
        };

        self.bus.ingest(&def, candidates, now).await
    }

    /// Drain the unified `FiredTrigger` channel forever. A failed duty is a logged line,
    /// never a crash of the loop (logging-not-rollback, PRD §7.5).
    pub async fn run(self: Arc<Self>, mut rx: mpsc::Receiver<FiredTrigger>) {
        while let Some(fired) = rx.recv().await {
            let def_id = fired.def_id.clone();
            if let Err(e) = self.process(fired, Utc::now().timestamp()).await {
                eprintln!("ingest: duty `{def_id}` failed: {e}");
            }
        }
    }

    /// The read-scoped env injected into sensors (PRD §5.2): only `PATH` (so interpreters
    /// resolve) plus the operator's explicitly `forwarded_env` names. **No soul key** — that
    /// is never forwarded (PRD §7.2). A name with no value in the harness env is skipped.
    fn sensor_env(&self) -> HashMap<String, String> {
        let mut env = HashMap::new();
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
        for name in &self.config.forwarded_env {
            if let Ok(v) = std::env::var(name) {
                env.insert(name.clone(), v);
            }
        }
        env
    }
}

/// Reload the registry from `stimuli/` and re-push cron/webhook routes (PRD §5.1 hot-reload).
/// The deterministic core the file-watcher calls; also directly testable.
pub async fn reload(
    repo_root: &PathBuf,
    registry: &Arc<RwLock<Registry>>,
    cron: &dyn CronScheduler,
    webhook: &dyn WebhookListener,
) -> Result<()> {
    let reg = Registry::load(repo_root)?;
    let crons = reg.cron_routes();
    let hooks = reg.webhook_routes();
    *registry.write().unwrap() = reg;
    cron.reschedule(&crons).await?;
    webhook.set_routes(&hooks).await?;
    Ok(())
}

/// Watch `<repo_root>/stimuli/` and [`reload`] on any change. Returns the watcher handle —
/// **the caller must keep it alive** (dropping it stops watching). Must be called inside a
/// tokio runtime (it spawns reload tasks).
pub fn spawn_stimuli_watcher(
    repo_root: PathBuf,
    registry: Arc<RwLock<Registry>>,
    cron: Arc<dyn CronScheduler>,
    webhook: Arc<dyn WebhookListener>,
) -> Result<RecommendedWatcher> {
    let handle = tokio::runtime::Handle::current();
    let stimuli = repo_root.join("stimuli");
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_err() {
            return;
        }
        let (repo_root, registry, cron, webhook) =
            (repo_root.clone(), registry.clone(), cron.clone(), webhook.clone());
        handle.spawn(async move {
            if let Err(e) = reload(&repo_root, &registry, cron.as_ref(), webhook.as_ref()).await {
                eprintln!("stimuli hot-reload failed: {e}");
            }
        });
    })
    .map_err(|e| DackError::Config(format!("file watcher: {e}")))?;
    watcher
        .watch(&stimuli, RecursiveMode::Recursive)
        .map_err(|e| DackError::Config(format!("watch {stimuli:?}: {e}")))?;
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::SqliteQueue;
    use crate::sensor::SubprocessSensor;

    fn write_exec(path: &std::path::Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    /// PRD §11.4 acceptance: *a cron hook runs a script and registers a deduped stimulus row.*
    /// We drive `process` directly (the cron wheel's firing is proven in `sources::cron`),
    /// so the assertion is deterministic: a real sensor script emits two same-keyed
    /// candidates, and the batch policy folds them into **one** queued row.
    #[tokio::test]
    async fn cron_fire_runs_a_script_and_registers_a_deduped_row() {
        let root = std::env::temp_dir().join(format!("dack-ingest-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();

        write_exec(
            &root.join("stimuli/poller/scripts/emit.sh"),
            "#!/bin/sh\n\
             printf '{\"type\":\"poll_item\",\"payload\":{\"n\":1},\"dedup_key\":\"t1\"}\\n'\n\
             printf '{\"type\":\"poll_item\",\"payload\":{\"n\":2},\"dedup_key\":\"t1\"}\\n'\n",
        );
        std::fs::write(
            root.join("stimuli/poller/STIMULUS.md"),
            "---\nid: poller\ntrigger: { type: cron, schedule: \"* * * * *\" }\n\
             sensor: ./scripts/emit.sh\ndirective_tier: self\n\
             emits:\n  type: poll_item\n  default_payload_tier: public\n\
             coalesce: { mode: batch, window_sec: 600, dedup_key: thread }\n\
             route: perceive\n---\nPoll directive.\n",
        )
        .unwrap();

        let config = Arc::new(DackConfig::from_yaml("operator_did: \"did:key:zOp\"").unwrap());
        let queue: Arc<dyn crate::queue::Queue> = Arc::new(SqliteQueue::open_in_memory().unwrap());
        let ingestor = Ingestor {
            repo_root: root.clone(),
            config: config.clone(),
            bus: Arc::new(Bus::new(config, queue.clone())),
            queue: queue.clone(),
            sensor: Arc::new(SubprocessSensor::new()),
            broker: Arc::new(SecretsBroker::new(vec![])),
            registry: Arc::new(RwLock::new(Registry::load(&root).unwrap())),
        };

        // Simulate the cron fire.
        let ids = ingestor
            .process(FiredTrigger { def_id: "poller".into(), payload: vec![] }, 1000)
            .await
            .expect("sensor ran + bus ingested");

        assert_eq!(ids.len(), 1, "two candidates coalesced into one wake");
        assert_eq!(queue.depth().await.unwrap(), 1, "exactly one deduped row queued");
        let row = queue.next().await.unwrap().unwrap();
        let items = row.payload.get("items").and_then(|v| v.as_array()).unwrap();
        assert_eq!(items.len(), 2, "both polled items folded into the row");

        std::fs::remove_dir_all(&root).ok();
    }

    /// An unknown / vanished duty (hot-reload race) is dropped, never a panic.
    #[tokio::test]
    async fn unknown_duty_is_dropped_quietly() {
        let root = std::env::temp_dir().join(format!("dack-ingest-x-{}", std::process::id()));
        let config = Arc::new(DackConfig::from_yaml("operator_did: \"did:key:zOp\"").unwrap());
        let queue: Arc<dyn crate::queue::Queue> = Arc::new(SqliteQueue::open_in_memory().unwrap());
        let ingestor = Ingestor {
            repo_root: root.clone(),
            config: config.clone(),
            bus: Arc::new(Bus::new(config, queue.clone())),
            queue,
            sensor: Arc::new(SubprocessSensor::new()),
            broker: Arc::new(SecretsBroker::new(vec![])),
            registry: Arc::new(RwLock::new(Registry::default())),
        };
        let ids = ingestor
            .process(FiredTrigger { def_id: "ghost".into(), payload: vec![] }, 1)
            .await
            .unwrap();
        assert!(ids.is_empty());
    }
}
