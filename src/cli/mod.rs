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
use crate::model::stimulus::{Priority, Stimulus, StimulusId, StimulusStatus, StimulusType, TrustTier};
use crate::queue::{Queue, SqliteQueue};
use crate::repo::git::PlainGitRepo;
use crate::repo::gitlawb::GitlawbRepo;
use crate::repo::{CommitMeta, RepoHost, RepoPath};
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
    /// Force a Reflect run now (an explicit operator override of the scheduled cadence, PRD §4.2).
    ReflectNow,
    /// Commit external/hand edits to the soul tree (memory/prompts/stimuli) as the operator, so
    /// the daemon's per-run integrity tripwire doesn't revert them (PRD §7.5, §8.3).
    Reconcile,
}

/// Dispatch a parsed CLI command. `run`/`status`/`log` are the daemon + read surfaces; `say`/
/// `pause`/`resume`/`reflect-now`/`reconcile` are the operator controls that act on the shared
/// SQLite queue (cursor flags + injected stimuli) the running daemon observes (PRD §8.3).
pub async fn dispatch(cli: Cli) -> Result<()> {
    match cli.command {
        Command::Run => run(&cli.config).await,
        Command::Status => status(&cli.config).await,
        Command::Log { follow } => log_cmd(&cli.config, follow).await,
        Command::Say { instruction } => say(&cli.config, instruction).await,
        Command::Pause => set_paused(&cli.config, true).await,
        Command::Resume => set_paused(&cli.config, false).await,
        // The hard stop is SIGTERM (graceful drain) — `systemctl stop dack` / Ctrl-C. A pidfile
        // kill buys nothing over the signal the daemon already drains on cleanly (PRD §11.8).
        Command::Kill => Err(DackError::NotImplemented(
            "dack kill — use SIGTERM (systemctl stop / Ctrl-C) for a graceful drain",
        )),
        Command::ReflectNow => reflect_now(&cli.config).await,
        Command::Reconcile => reconcile(&cli.config).await,
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

/// `dack say` (PRD §8.3) — the operator→agent channel. Signs the instruction with the operator
/// key and enqueues it as an `operator_signed`-CLAIMING stimulus; the running daemon VERIFIES the
/// signature at dispatch (invariant I18) before honoring the tier — a self-asserted label is never
/// trusted. The operator key signs HERE; the daemon needs only the public operator DID to verify,
/// so the soul/operator private keys never have to meet (PRD §3.3, §7.2).
async fn say(config_path: &str, instruction: String) -> Result<()> {
    let config = DackConfig::load(config_path)?;
    let identity = GitlawbIdentity::resolve("gl", config.identity_dirs()).await?;
    if identity.did(IdentityRole::Operator).is_none() {
        return Err(DackError::Config(
            "dack say: no operator identity dir (identities.operator) — cannot sign".into(),
        ));
    }
    let sig = identity
        .sign(IdentityRole::Operator, instruction.as_bytes())
        .await?;
    let sig_b64 = String::from_utf8_lossy(&sig.0).trim().to_string();

    let now = chrono::Utc::now().timestamp();
    let stim = Stimulus {
        id: StimulusId(format!("say-{now}")),
        source: "operator-say".into(),
        type_: StimulusType::from("operator_instruction"),
        // CLAIMED operator_signed — the daemon re-derives the REAL tier by verifying the signature.
        directive_tier: TrustTier::operator(),
        payload_tier: TrustTier::self_(),
        payload: serde_json::json!({ "instruction": instruction }),
        provenance: Some(format!("operator_sig:{sig_b64}")),
        received_at: now,
        dedup_key: None,
        // The operator's word is the highest-trust stimulus — let it jump the queue.
        priority: Priority::Urgent,
        status: StimulusStatus::Pending,
        directive_body: instruction,
        entry: config.default_entry.clone(),
    };
    SqliteQueue::open(&config.db_path)?.enqueue(stim).await?;
    println!("dack: operator instruction enqueued (signed; the daemon verifies on dispatch).");
    Ok(())
}

/// `dack pause` / `dack resume` (PRD §8.3) — the soft kill-switch. A shared flag in the queue
/// `cursor` table (the daemon and the CLI open the same SQLite); the consciousness loop checks it
/// at each cycle boundary and idles while set. An in-flight dispatch always finishes first.
async fn set_paused(config_path: &str, paused: bool) -> Result<()> {
    let config = DackConfig::load(config_path)?;
    let queue = SqliteQueue::open(&config.db_path)?;
    queue.set_cursor("paused", if paused { "1" } else { "" }).await?;
    println!(
        "dack: dispatch {} (in-flight runs finish; the loop {} new stimuli).",
        if paused { "PAUSED" } else { "RESUMED" },
        if paused { "stops popping" } else { "resumes popping" }
    );
    Ok(())
}

/// `dack reflect-now` (PRD §4.2, §8.3) — force a Reflect run now, an explicit operator override of
/// the scheduled cadence. Enqueues the same harness-entered Reflect stimulus the nightly schedule
/// would; entry-Reflect is not rate-limited (the rate-limit guards the *cadence*, which the operator
/// is deliberately overriding here). The running daemon picks it up single-flight.
async fn reflect_now(config_path: &str) -> Result<()> {
    let config = DackConfig::load(config_path)?;
    let now = chrono::Utc::now().timestamp();
    SqliteQueue::open(&config.db_path)?
        .enqueue(crate::harness::reflect_stimulus(now))
        .await?;
    println!("dack: Reflect run enqueued (the daemon will pick it up).");
    Ok(())
}

/// `dack reconcile` (PRD §7.5, §8.3) — commit external/hand edits to the soul tree
/// (memory/prompts/stimuli) so the daemon's per-run integrity tripwire (`reconcile_soul`, which
/// reverts anything outside the running state's writable dirs) doesn't clobber them. Commits are
/// authored as the **operator DID** (the human shaping the soul, distinct from the duck's Soul-DID
/// Reflect output) and pushed with the soul key (the node credential — author and push are
/// independent: `commit_paths` stamps the author, `push` uses `GITLAWB_KEY`).
async fn reconcile(config_path: &str) -> Result<()> {
    let config = DackConfig::load(config_path)?;
    let repo_root = std::fs::canonicalize(&config.soul_repo)
        .unwrap_or_else(|_| PathBuf::from(&config.soul_repo));
    let author = config.operator_did.clone();
    let repo: Arc<dyn RepoHost> = match (&config.soul_remote, &config.identities.soul) {
        (Some(remote), Some(soul_dir)) => {
            let soul_dir =
                std::fs::canonicalize(soul_dir).unwrap_or_else(|_| PathBuf::from(soul_dir));
            Arc::new(GitlawbRepo::new(
                &repo_root,
                author.clone(),
                remote.clone(),
                soul_dir,
                config.gitlawb_node.clone(),
            ))
        }
        _ => Arc::new(PlainGitRepo::new(&repo_root, author.clone())),
    };

    let changes = repo.status().await?;
    if changes.is_empty() {
        println!("dack: soul tree clean — nothing to reconcile.");
        return Ok(());
    }
    let paths: Vec<RepoPath> = changes.iter().map(|c| c.path.clone()).collect();
    let commit = CommitMeta {
        message: format!("reconcile {} external path(s) (operator)", paths.len()),
        author_did: author,
    };
    match repo.commit_paths(&paths, &commit).await? {
        Some(id) => {
            for p in &paths {
                println!("  + {}", p.0);
            }
            println!("dack: committed {} path(s) as operator ({}).", paths.len(), id.0);
            if let Err(e) = repo.push().await {
                eprintln!("dack: push failed (kept local; the daemon re-pushes next cycle): {e}");
            }
        }
        None => println!("dack: nothing staged — tree already clean at HEAD."),
    }
    Ok(())
}

/// Boot the ingestion pipeline (Phase 3): cron + webhook → sensor → bus → SQLite queue,
/// with `stimuli/` hot-reload. The consciousness consumer (queue → runtime → wall) lands in
/// Phase 4; until then `run` keeps the duck's senses live and the queue filling.
async fn run(config_path: &str) -> Result<()> {
    let config = Arc::new(DackConfig::load(config_path)?);
    // Fail fast if the capability prefixes overlap (a settle tool must never classify as Post).
    config.validate_capabilities()?;
    // Dry-run (testing): the WALL denies the configured tool prefixes so outward actions are
    // composed-but-not-executed — uniformly across every MCP (twitter, cove, …). No per-server env.
    if config.dry_run.enabled {
        eprintln!(
            "dack: DRY-RUN — the wall blocks these tool prefixes (composed, not executed): {}",
            config.dry_run.block.join(", ")
        );
    }
    // Absolutize the soul repo so sensor exes (spawned with a changed cwd) and the signed-push
    // `GITLAWB_KEY` resolve regardless of where `dack` is launched from (relative config paths
    // otherwise break under subprocess cwd changes). Falls back to as-written if it doesn't exist.
    let repo_root = std::fs::canonicalize(&config.soul_repo)
        .unwrap_or_else(|_| PathBuf::from(&config.soul_repo));

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
    // The runtime extensibility point: only openclaude+opengateway is wired; any other engine or
    // connector is a clear `NotImplemented` (the config slot exists, the adapter doesn't yet).
    let runtime: Arc<dyn RuntimeClient> = build_runtime(&config)?;
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
        (Some(remote), Some(soul_dir)) => {
            // Absolutize the identity dir: `GITLAWB_KEY` is read by the push helper running with
            // cwd = the soul repo, so a relative dir would not resolve (→ unsigned / 401).
            let soul_dir = std::fs::canonicalize(soul_dir)
                .unwrap_or_else(|_| PathBuf::from(soul_dir));
            Arc::new(GitlawbRepo::new(
                &repo_root,
                soul_did.clone(),
                remote.clone(),
                soul_dir,
                config.gitlawb_node.clone(),
            ))
        }
        _ => {
            eprintln!("dack: no soul_remote/identities.soul — plain-git, local-only (no signed push)");
            Arc::new(PlainGitRepo::new(&repo_root, soul_did.clone()))
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
        sessions: Default::default(),
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
        let sd = shutdown_rx.clone();
        async move {
            if let Err(e) = h.run(sd).await {
                eprintln!("dack: consciousness loop stopped: {e}");
            }
        }
    });
    eprintln!("dack: consciousness loop up (queue → Perceive → wall → Express).");
    // The scheduled Reflect ticker (PRD §4.2): enqueues a harness-entered Reflect at `reflect_schedule`
    // (no-op if unset). Harness-owned so it survives `stimuli/` hot-reloads. `dack reflect-now` is the
    // out-of-band manual trigger of the same run.
    tokio::spawn({
        let h = harness.clone();
        let sd = shutdown_rx.clone();
        async move { h.reflect_scheduler(sd).await }
    });

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
    // The ingestion loop is the process's main future. Stop it on shutdown too, so the whole
    // daemon exits (systemd then restarts it) instead of the consciousness loop alone draining.
    let mut sd = shutdown_rx;
    tokio::select! {
        _ = ingestor.run(rx) => {}
        _ = sd.changed() => eprintln!("dack: ingestion stopping — shutdown"),
    }
    eprintln!("dack: stopped cleanly.");
    Ok(())
}

/// Construct the runtime client from `config.runtime` (the engine + connector extensibility point).
/// Only `openclaude`+`opengateway` is wired; any other engine/connector returns a clear
/// `NotImplemented` (the config parses, the adapter just isn't built yet — see `RuntimeConfig`).
fn build_runtime(config: &DackConfig) -> Result<Arc<dyn RuntimeClient>> {
    use crate::config::{Connector, RuntimeEngine};
    let rt = &config.runtime;
    let RuntimeEngine::Openclaude { bridge_dir } = &rt.engine;
    // (engine is exhaustive today — a future `ClaudeCode` arm lands with its own adapter here.)
    if let Connector::Anthropic { .. } = rt.connector {
        return Err(DackError::NotImplemented(
            "runtime.connector: anthropic — not wired yet (only opengateway). \
             The model channel (options.model) is supported; the env/auth wiring is the TODO.",
        ));
    }
    // The bridge env = the forwarded names + the connector's own creds (base URL, key, flags),
    // applied on top so the inline config wins. The provider key reaches the bridge, never the agent.
    let mut env = bridge_env(config);
    for (k, v) in rt.connector.env_overrides() {
        env.insert(k, v);
    }
    Ok(Arc::new(OpenClaudeClient::bun_bridge(
        bridge_dir,
        env,
        rt.model.clone(),
        rt.connector.model_via_openai_env(),
        std::time::Duration::from_secs(config.invoke_timeout_secs),
    )))
}

/// Env forwarded into the runtime bridge: `PATH`/`HOME` + the provider/capability names the
/// operator listed (`runtime.env` + `forwarded_env`). Values come from the harness env; the
/// soul key is never among them (PRD §7.2).
fn bridge_env(config: &DackConfig) -> HashMap<String, String> {
    let mut env = HashMap::new();
    for key in ["PATH", "HOME"] {
        if let Ok(v) = std::env::var(key) {
            env.insert(key.to_string(), v);
        }
    }
    for name in config.runtime.env.iter().chain(config.forwarded_env.iter()) {
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
