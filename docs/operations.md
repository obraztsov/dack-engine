# Operations

Running, observing, and maintaining a live agent.

## CLI reference

All commands are `dack <command>` (or `cargo run --release -- <command>`).

| Command | Purpose |
|---|---|
| `dack run` | Boot the harness and process stimuli — the long-running actor. Runs the ingestion loop, the consciousness loop, the modules supervisor, and the Reflect scheduler until stopped. |
| `dack say "<text>"` | Inject a trusted `operator_signed` instruction into the queue (signed with the operator key, verified against `operator_did`). |
| `dack status` | Liveness, queue depth, uptime + cycle counts, and machinery health (secrets, MCP servers, the duty roster). |
| `dack log [--follow]` | Tail the runlog — the agent's "syslog" (reads the SQLite runlog store). |
| `dack pause` | Soft kill-switch: stop popping the queue (work keeps queuing). |
| `dack resume` | Resume popping the queue. |
| `dack reflect-now` | Force a Reflect (self-modification) run now, overriding the scheduled cadence. |
| `dack reconcile` | Commit your hand-edits to the soul tree as the operator, so the integrity tripwire doesn't revert them. |
| `dack keygen --role <r> --dir <d>` | Generate a native Ed25519 identity (`<dir>/identity.pem`, 0600) and print its `did:key`. No external tools. |
| `dack migrate-runlogs` | One-shot: import the legacy markdown runlogs into the SQLite store (`--from` / `--to` override the defaults). |
| `dack kill` | Not implemented — use SIGTERM (`systemctl stop` / `docker stop` / Ctrl-C) for a graceful drain. |

## Daemon lifecycle

`dack run` is the single process that starts the agent's whole runtime — its mind and its channels.
Run it under a process supervisor (systemd, a container restart policy) in production. It handles
SIGTERM/SIGINT gracefully: the in-flight cycle finishes, modules are torn down, and the process exits
cleanly, so a supervisor restart reclaims any orphaned work and posts a "back online" stimulus.

The queue is durable (embedded SQLite at `db_path`), so a restart loses no pending work — only the
in-flight cycle, which is reclaimed. The database is otherwise disposable: deleting it loses only the
queue, not the agent (its identity and memory live in the soul repo).

## Concurrency

`max_concurrent_cycles` (default `1`) is the size of the wake-cycle worker pool. At `1` the daemon is
single-flight — one cycle at a time, byte-identical to the pre-multithreading behavior. Raise it (e.g.
`4`) to process independent conversations in parallel; the pool is still bounded by two invariants:

- **A single chat serializes** — one in-flight wake per `dedup_key`, so replies within a conversation
  never reorder. *Different* chats run concurrently.
- **Write-lock cycles run exclusively** — Settle, Reflect, and digest jobs take the memory/soul
  write-lock, so they never overlap another cycle; a `parallel: true` prompt takes only a read-lock.

Bound it by the model gateway's rate/cost budget, not by CPU.

## Observing a run

There are two distinct streams, for two audiences:

- **The runlog** is the *agent's* record of every cycle: the model's thought, each tool it called with
  the wall's verdict (allow / deny / dry-run), the transition it took, and the raw stimulus (clearly
  marked as untrusted). It's a single harness-authored **SQLite+FTS5** store (`runlogs.sqlite`, config
  `runlog_db`) that lives *outside* the soul — the agent's short-term memory, append-only and
  retention-bounded (`runlog_retention_days`), which the agent reaches read-only through its recall MCP
  tools rather than the file. It's disposable: losing it loses only short-term memory (durable = prompts
  + long-term `memory/`), and a fresh DB is created on a missing/corrupt file. `dack log --follow` tails
  it. (Coming from a pre-v0.2.0 soul with markdown runlogs? `dack migrate-runlogs` imports them once.)
- **The operational log** (stdout, via the `tracing` framework — configured by `log` in
  [configuration](configuration.md#log--structured-logging)) is the *operator's* stream: boot, scheduling
  decisions, every model call's latency + token usage, soul pushes, tripwire reverts, errors. On a TTY it's
  pretty text; piped or containerized it's **JSON** (one object per line) for `docker logs` / a log
  backend. Every line carries a `cycle{stim=…}` correlation span. Set `RUST_LOG` (e.g.
  `RUST_LOG=dack::harness=debug`) for per-module verbosity. Levels: `trace` (context-assembly internals) ·
  `debug` (decisions) · `info` (lifecycle) · `warn`/`error` (failures).

`dack status` gives the at-a-glance view — queue depth, uptime + cycle counts (ok / errored), and the
machinery-health snapshot the daemon writes every ~15s:

- **Secrets** — each configured provider `ok` or `FAILING`, with its consecutive-failure streak and last
  error (so a dead X token surfaces here, not just in the logs).
- **MCP servers** — per-server connect liveness; a remote capability server that keeps failing to connect
  (e.g. a staging endpoint down) shows a failure streak.
- **Stimuli** — the full configured duty roster, each annotated with its fires and failures (including a
  mis-scheduled duty that has *never fired*).

The same snapshot feeds a trusted `subconscious-health` block in the **Reflect** prompt, so the agent
itself notices a degradation (a failing token, a dead MCP) and can record it in memory.

## The soul repo

The agent's durable identity is a git repository (`soul_repo`), separate from the engine. The harness
commits to it after each run — the per-cycle changes (memory, any Reflect edits) plus the runlog.

It's **one local git repo**; `soul_remotes` is the list of plain-git remotes it's pushed to after each
cycle — GitHub / GitLab / Gitea / self-hosted / a local path, each a normal `git push`. Each target is
**best-effort** unless `required: true`, so a flaky mirror never blocks a cycle — the next cycle
re-pushes. List several to get redundancy:

```yaml
soul_remotes:
  - url: "git@github.com:youruser/my-soul.git"        # reliable primary
    required: true
  - url: "git@gitlab.com:youruser/my-soul.git"         # mirror, best-effort
```

- **Local-only.** Omit `soul_remotes` entirely. Commits are local; nothing is pushed.
- **Plain git (GitHub / GitLab / Gitea / self-hosted).** A normal `git push`. Commits are authored as
  the Soul DID (attribution by author identity).

The legacy single `soul_remote:` field still works — it's treated as a one-element best-effort list.

### Pushing to a GitHub (or any plain-git) remote

GitHub transport auth is **separate from the soul DID** — GitHub doesn't understand DIDs, so the DID
keys don't grant push. The DID stays the commit *author*; you authenticate the *push* with ordinary
GitHub credentials:

- **SSH (simplest).** Add a deploy key (or your machine's SSH key) to the repo on GitHub, and use the
  `git@github.com:owner/repo.git` URL. No token in config — the ambient SSH key authenticates.
- **HTTPS token.** Create a fine-grained PAT with `contents: write` on that repo, export it in the
  daemon's environment (e.g. `GITHUB_TOKEN`), and reference it with `auth: { token_env: GITHUB_TOKEN }`.
  The token is read at push time and injected as an ephemeral credential — never written to disk, never
  on a command line, never in the agent's context.

The repo must already exist on GitHub (create it empty, no auto-README, to avoid a non-fast-forward on
the first push).

### Identities

Identity directories provide the signing keys, one per role:

```yaml
identities:
  soul: "identities/soul"          # authors/attributes soul commits; NEVER in agent env
  operator: "identities/operator"  # signs `dack say`
  builder: "identities/builder"
```

Create each with `dack keygen --role <role> --dir identities/<role>` — native Ed25519, each directory
holding a private `identity.pem`, no external tools. **Gitignore `/identities/`** — these are private keys.
The Soul key in particular is harness-only: it signs the agent's commits but is never forwarded into the
agent's environment, so the model can never sign as itself.

## Hand-editing the soul

The harness runs an **integrity tripwire**: after each cycle it reverts any change to the soul made
outside a Reflect run (this is what keeps self-modification gated to Reflect). If *you* edit the soul
by hand — tweak a prompt, add a duty, fix memory — the tripwire would revert it on the next cycle. Run
`dack reconcile` first: it commits your tracked edits as the operator, so the tripwire treats them as
intended.

Files the soul gitignores (worker `workspaces/`, secrets) are invisible to the tripwire and never
reverted.

## Reconfiguring a running duck (remote-authoritative soul)

Opt into `soul_remote_authority: true` and `dack run` reconciles the local soul against its **primary
remote at boot** — remote-authoritative for config and prompts, while `soul_local_paths` (default
`memory/`) is kept local. This gives you a push-to-reconfigure workflow: to change a running duck,

1. push the config/prompt change to its private soul repo, then
2. restart the daemon.

The duck adopts the pushed changes at boot and keeps its own memory. It's safe by construction: the
reconcile **skips a dirty working tree** (run `dack reconcile` first to commit hand-edits, or they're
left untouched), and on a divergence it **snapshots local `HEAD` to a `pre-sync-<ts>` branch** before
adopting the remote — nothing is lost. A fetch failure is non-fatal; the duck just boots on its local
soul. Default is `false` (local-authoritative, no boot fetch).

## Self-modification cadence

Reflect runs are rate-limited by `reflect_min_interval_secs` (default daily), enforced for both the
scheduled run (`reflect_schedule`) and any Reflect reached by a transition. `dack reflect-now` is the
manual override. Because Reflect is the only state that can write the agent's own prompts, this cadence
bounds how fast the agent changes itself.

## Channels

Long-running channel adapters run as `modules` under the supervisor — they start and stop with
`dack run`, restart on failure, and need no separate process management. See [channels](channels.md).

## Workers

Delegated workers run on the host by default. To OS-isolate them in Docker, build the worker image and
enable `runtime.worker_sandbox`; see [workers](workers.md). Worker `workspaces/` are swept at boot.

## Production checklist

- Gitignore `dack.config.yaml`, `/identities/`, `/secrets/`, and the soul's `workspaces/`.
- Run `dack run` under a supervisor with a restart policy.
- Set `soul_remotes` + `identities.soul` to push the soul off-box for attributable history (a plain-git
  remote is author-attributable; list several for redundancy).
- Keep the model endpoint reachable; a hung invocation elapses at `invoke_timeout_secs` and the loop
  continues rather than freezing.
- Use `dry_run` to rehearse outward actions before going live.

## Deployment

To run the daemon in a container or on a VPS (Docker image, systemd unit, volume layout), see
[deployment](deployment.md).
