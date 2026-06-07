//! Operator CLI (PRD §8.3) — the v1 operator interface (NOT a web dashboard; §8.1).
//! The operator's real needs are few and map to a CLI + a tailable log.
//!
//! `dack say` is the operator→agent channel: it writes a `Stimulus` row with
//! `operator_signed` tier, signed by the operator DID — so the trust model is uniform
//! (operator instructions are *just* the highest-trust stimulus, not a special path).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use clap::{Parser, Subcommand};
use tokio::sync::mpsc;

use crate::bus::Bus;
use crate::config::DackConfig;
use crate::error::{DackError, Result};
use crate::harness::ingest::{spawn_stimuli_watcher, Ingestor};
use crate::harness::Harness;
use crate::identity::gitlawb::GitlawbIdentity;
use crate::identity::{IdentityProvider, IdentityRole};
use crate::queue::{Queue, SqliteQueue};
use crate::repo::git::PlainGitRepo;
use crate::repo::gitlawb::GitlawbRepo;
use crate::repo::RepoHost;
use crate::runlog::{DailyFileRunLog, RunLogWriter};
use crate::runtime::openclaude::OpenClaudeClient;
use crate::runtime::RuntimeClient;
use crate::sensor::{SensorRunner, SubprocessSensor};
use crate::sources::{CronScheduler, CronWheel};
use crate::stimuli::Registry;
use crate::webserver::{AxumWebhookListener, WebhookListener};

#[derive(Parser, Debug)]
#[command(name = "dack", about = "DACK actor-scheduler harness")]
pub struct Cli {
    /// Path to the operator config (PRD §8.2).
    #[arg(long, default_value = "dack.config.yaml")]
    pub config: String,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Boot the harness and process stimuli (the long-running actor-scheduler).
    Run,
    /// Is it alive, last run, queue depth, current state.
    Status,
    /// Syslog-style tail of runlogs (the "agent syslog").
    Log {
        #[arg(long)]
        follow: bool,
    },
    /// Inject an `operator_signed` stimulus (trusted) into the DB.
    Say { instruction: String },
    /// Halt dispatch (soft kill-switch).
    Pause,
    /// Resume dispatch.
    Resume,
    /// Stop processes (hard).
    Kill,
    /// (placeholder) extend VPS/inference runway.
    Fund,
    /// Force a Reflect run (the only non-scheduled way to enter Reflect, PRD §4.2).
    ReflectNow,
}

/// Dispatch a parsed CLI command. SCAFFOLD: command bodies land alongside their phases
/// (run/status = Phase 3; log/pause/kill = Phase 7-8; say + reflect-now = Phase 8;
/// reflect-now = Phase 8).
pub async fn dispatch(cli: Cli) -> Result<()> {
    match cli.command {
        Command::Run => run(&cli.config).await,
        Command::Status => status(&cli.config).await,
        Command::Log { follow } => log_cmd(&cli.config, follow).await,
        // Clean `NotImplemented` (not a panic): a stray invocation logs, never crashes (PRD §7.5).
        Command::Say { instruction: _ } => Err(DackError::NotImplemented(
            "dack say — Phase 8 (verified operator_signed stimulus, signed by operator DID)",
        )),
        Command::Pause => Err(DackError::NotImplemented("dack pause — kill-switch, Phase 8")),
        Command::Resume => Err(DackError::NotImplemented("dack resume — Phase 8")),
        // The hard stop is SIGTERM (graceful drain) — `systemctl stop dack` / Ctrl-C.
        Command::Kill => Err(DackError::NotImplemented(
            "dack kill — use SIGTERM (systemctl stop / Ctrl-C) for a graceful drain",
        )),
        Command::Fund => Err(DackError::NotImplemented("dack fund — runway placeholder")),
        Command::ReflectNow => Err(DackError::NotImplemented(
            "dack reflect-now — Phase 8 (enqueue a harness-entered Reflect run)",
        )),
    }
}

/// `dack log` (PRD §8.3) — the "agent syslog": print today's runlog, and with `--follow` stream
/// new entries as the duck writes them (naive size-poll; the runlog is append-only).
async fn log_cmd(config_path: &str, follow: bool) -> Result<()> {
    use std::io::Write;
    let config = DackConfig::load(config_path)?;
    let date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let path = PathBuf::from(&config.soul_repo).join(format!("runlogs/{date}.md"));
    let mut shown = 0usize;
    loop {
        let text = tokio::fs::read_to_string(&path).await.unwrap_or_default();
        if text.len() > shown {
            print!("{}", &text[shown..]);
            std::io::stdout().flush().ok();
            shown = text.len();
        }
        if !follow {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    }
    Ok(())
}

/// Boot the ingestion pipeline (Phase 3): cron + webhook → sensor → bus → SQLite queue,
/// with `stimuli/` hot-reload. The consciousness consumer (queue → runtime → wall) lands in
/// Phase 4; until then `run` keeps the duck's senses live and the queue filling.
async fn run(config_path: &str) -> Result<()> {
    let config = Arc::new(DackConfig::load(config_path)?);
    let repo_root = PathBuf::from(&config.soul_repo);

    let queue: Arc<dyn Queue> = Arc::new(SqliteQueue::open(&config.db_path)?);
    let bus = Arc::new(Bus::new(config.clone(), queue.clone()));
    let registry = Arc::new(RwLock::new(Registry::load(&repo_root)?));
    let sensor: Arc<dyn SensorRunner> = Arc::new(SubprocessSensor::new());

    // One unified FiredTrigger channel drained by the ingestor; cron + webhook both feed it.
    let (tx, rx) = mpsc::channel(256);
    let cron = CronWheel::new(tx.clone());
    let addr: SocketAddr = config
        .webhook_addr
        .parse()
        .map_err(|e| DackError::Config(format!("webhook_addr `{}`: {e}", config.webhook_addr)))?;
    let webhook = AxumWebhookListener::new(addr, tx);

    // Initial schedule + routes from the registry.
    {
        let reg = registry.read().unwrap();
        cron.reschedule(&reg.cron_routes()).await?;
        webhook.set_routes(&reg.webhook_routes()).await?;
        eprintln!(
            "dack: {} duties registered ({} malformed); webhook on {addr}",
            reg.defs.len(),
            reg.errors.len()
        );
    }

    // Spawn the sources + the hot-reload watcher (kept alive for the process lifetime).
    tokio::spawn(cron.clone().run());
    tokio::spawn(webhook.clone().serve());
    let _watcher =
        spawn_stimuli_watcher(repo_root.clone(), registry.clone(), cron.clone(), webhook.clone())?;

    // ── Consciousness loop (Phase 4): pop the queue → invoke states → the wall ──
    // Shares the queue with ingestion (senses write, cognition reads). The runtime spawns
    // the bun bridge per invocation; if it's unreachable, dispatch errors are logged and the
    // loop stays up (logging-not-rollback). repo/identity are wired but inert until Phase 5/6.
    let runtime: Arc<dyn RuntimeClient> = Arc::new(OpenClaudeClient::bun_bridge(
        &config.bridge_dir,
        bridge_env(&config),
        config.model.clone(),
        std::time::Duration::from_secs(config.invoke_timeout_secs),
    ));
    // Identity: resolve the configured `gl` role dirs. The Soul dir signs soul commits + the
    // `gitlawb://` push; its key never enters agent env (PRD §3.3, §7.2).
    let identity: Arc<dyn IdentityProvider> =
        Arc::new(GitlawbIdentity::resolve("gl", config.identity_dirs()).await?);
    let soul_did = identity
        .did(IdentityRole::Soul)
        .map(|d| d.0.clone())
        .unwrap_or_else(|| config.operator_did.clone());

    // Repo-host: a signed `gitlawb://` soul repo when a remote + Soul identity dir are
    // configured, else plain git (degraded mode, PRD §3.5). The Soul DID attributes the
    // commit history to the duck; the signed push is the cryptographic provenance.
    let repo: Arc<dyn RepoHost> = match (&config.soul_remote, &config.identities.soul) {
        (Some(remote), Some(soul_dir)) => Arc::new(GitlawbRepo::new(
            &config.soul_repo,
            soul_did.clone(),
            remote.clone(),
            soul_dir.clone(),
            config.gitlawb_node.clone(),
        )),
        _ => {
            eprintln!("dack: no soul_remote/identities.soul — plain-git, local-only (no signed push)");
            Arc::new(PlainGitRepo::new(&config.soul_repo, soul_did.clone()))
        }
    };
    let runlog: Arc<dyn RunLogWriter> =
        Arc::new(DailyFileRunLog::new(repo.clone(), soul_did.clone()));
    // Secrets broker from config — trusted provider scripts; shared by sensors (per-duty
    // `secrets:`) and the Express act phase (per-route `secrets:`).
    let broker = Arc::new(crate::secrets::providers::broker_from_config(&config));
    let harness = Arc::new(Harness {
        config: config.clone(),
        queue: queue.clone(),
        bus: bus.clone(),
        runtime,
        repo,
        identity,
        runlog,
        broker: broker.clone(),
    });
    // Graceful shutdown: SIGTERM/SIGINT flips the watch; the consciousness loop finishes its
    // in-flight dispatch, then exits (no zombie `dispatched` row). systemd restarts on crash;
    // the next boot reclaims orphans + posts "back online" (PRD §11.8).
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! {
            _ = term.recv() => eprintln!("dack: SIGTERM — draining"),
            _ = tokio::signal::ctrl_c() => eprintln!("dack: SIGINT — draining"),
        }
        let _ = shutdown_tx.send(true);
    });
    tokio::spawn({
        let h = harness.clone();
        async move {
            if let Err(e) = h.run(shutdown_rx).await {
                eprintln!("dack: consciousness loop stopped: {e}");
            }
        }
    });
    eprintln!("dack: consciousness loop up (queue → Perceive → wall → Express).");

    let ingestor = Arc::new(Ingestor {
        repo_root,
        config,
        queue,
        bus,
        sensor,
        registry,
        broker,
    });
    eprintln!("dack: ingestion up (cron+webhook → bus → queue).");
    ingestor.run(rx).await;
    Ok(())
}

/// Env forwarded into the runtime bridge: `PATH`/`HOME` + the provider/capability names the
/// operator listed (`runtime_env` + `forwarded_env`). Values come from the harness env; the
/// soul key is never among them (PRD §7.2).
fn bridge_env(config: &DackConfig) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for key in ["PATH", "HOME"] {
        if let Ok(v) = std::env::var(key) {
            env.insert(key.to_string(), v);
        }
    }
    for name in config.runtime_env.iter().chain(config.forwarded_env.iter()) {
        if let Ok(v) = std::env::var(name) {
            env.insert(name.clone(), v);
        }
    }
    env
}

/// `dack status` (PRD §8.3) — Phase 3 slice: queue depth + duty registration health. The
/// alive/last-run/current-state fields fill in with the watchdog (Phase 7).
async fn status(config_path: &str) -> Result<()> {
    let config = DackConfig::load(config_path)?;
    let depth = SqliteQueue::open(&config.db_path)?.depth().await?;
    let reg = Registry::load(&config.soul_repo)?;
    println!("queue:  {depth} pending");
    println!(
        "duties: {} registered, {} malformed",
        reg.defs.len(),
        reg.errors.len()
    );
    for (path, err) in &reg.errors {
        println!("  ! {path}: {err}");
    }
    Ok(())
}
