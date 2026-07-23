# Architecture

dack-engine is a single Rust crate that runs one autonomous agent as a durable actor. It splits into
two halves: a **dumb, deterministic ingestion layer** that turns events into queued stimuli, and a
**consciousness loop** that pops the queue and drives the model through the wall. The model itself runs
out-of-process behind a thin TypeScript bridge.

```
 sources                ingestion (no reasoning)              cognition
 ───────                ──────────────────────                ─────────
 cron ──┐
 webhook├─► FiredTrigger ─► sensor ─► bus ─► SQLite queue ─► consciousness loop ─► the wall
 (poll) ┘                  (normalize, coalesce, seed trust)   (bounded pool)         │
                                                                     │                │ allow/deny
 modules (long-running channel adapters) ─► webhook ─────────┘       ▼                ▼
                                                              runtime bridge ◄──► model gateway
                                                              (bun + OpenClaude SDK)
                                                                     │
                                                              soul repo (prompts, memory,
                                                              stimuli, skills) — signed commits
```

## Ingestion layer

The half of the harness that touches attacker-influenced bytes. Everything here is **data**, never an
instruction; the firebreak sits downstream at Perceive.

- **Sources** (`src/sources/`) feed a single `FiredTrigger` channel. A **cron wheel** fires scheduled
  duties; a **webhook listener** (localhost-only, `webhook_addr`) accepts POSTs from local adapters.
- **Sensors** (`src/sensor/`) are the duty's optional fetch step — a script the harness runs with a
  read-scoped env (plus any provider-materialized secret token) to pull new items. A webhook duty
  needs no sensor: the POSTed body is already the payload.
- **The bus** (`src/bus/`) normalizes each candidate into a `Stimulus`, applies the duty's **coalesce**
  policy (fold a burst into one wake, optionally debounced), seeds its **trust tier** from the source
  (provenance), and enqueues it.
- **The queue** (`src/queue/`) is embedded SQLite — durable across restarts, single source of pending
  work. It supports priority ordering, exact-once leasing, batch coalescing, and a per-row debounce
  gate.

## Consciousness loop

`src/harness/` runs a bounded pool of wake-cycles — up to `max_concurrent_cycles` (config, default `1`
= serial single-flight) — over a `Semaphore` + `JoinSet`. Each cycle pops one stimulus and dispatches
it:

1. Resolve the stimulus's **entry state-prompt** and open a cycle there.
2. Assemble the invocation: the soul prompts as the system prompt, the digested context as user
   content, and the **MCP capabilities** the state-prompt requests ∩ what `tier_policy` admits ∩ what
   the cycle's current trust permits.
3. Invoke the runtime. Every tool the model calls is relayed back through **the wall**
   (`src/runtime/action_required.rs` + `src/state/`), which decides allow/deny by tool class, current
   state, and the path gate, and records each call in the runlog.
4. The model returns a structured output (a thought, an intent, an optional transition). The harness
   walks to the chosen transition if the cycle's trust ceiling reaches it, else terminates.

Harness-owned background tasks run alongside the loop: the **Reflect scheduler** (enqueues the nightly
self-modification run), the **modules supervisor** (keeps channel adapters alive), and the **stimuli
watcher** (hot-reloads the soul's duties).

### Concurrency

At `max_concurrent_cycles > 1` different threads of work run at once while two invariants hold, on
orthogonal axes:

- **Axis-1 — per-thread serialization.** At most one in-flight wake per `dedup_key`: the queue's
  `next_eligible(&busy)` (`src/queue/`) skips any key already running. A chat's messages never process
  out of order, and a sticky session never races itself. Different chats (distinct keys) run in
  parallel; the same chat serializes.
- **Axis-2 — the memory/soul lock.** Every `run_step` takes a per-cycle `tokio::RwLock` over
  memory+soul (`mem_lock`). The **write-lock is the default** — a writer's read-through-write of
  `memory/` is atomic, so any settle/reflect/digest cycle runs exclusively. A prompt with `parallel:
  true` frontmatter (`src/state_prompt.rs`) is read-only w.r.t. long-term state — the wall clears its
  `writable_dirs`, proving the read-lock sound (a parallel cycle makes **no** memory/soul file write) —
  so it takes a shared **read-lock** and runs concurrently.

Net: different chats process in parallel, the same chat serializes, and any write-lock cycle runs alone.

## The runtime bridge

The model runs out-of-process. `src/runtime/` defines a `RuntimeClient` trait; the wired
implementation spawns `bun run bridge.ts` (`openclaude-bridge/`), which drives the OpenClaude SDK and
speaks a small JSON protocol over stdio: one invocation in, a stream of permission events out (each
answered by the wall), and a final structured result. A pipe to a child is more confined than a
localhost socket — nothing binds, nothing is impersonable.

The runtime is an **extensibility seam**: `runtime.engine` chooses the agent runtime and
`runtime.connector` chooses how it reaches models. The wired connector is `openai-compatible` — an env
shim that sets `CLAUDE_CODE_USE_OPENAI=1` + `OPENAI_BASE_URL`/`OPENAI_API_KEY` and routes the per-state
model via `OPENAI_MODEL`, so you point it at any OpenAI-compatible endpoint. (A `serde` alias keeps old
`type: opengateway` configs parsing.) Swapping either seam is a config edit, not a code change. See
[configuration](configuration.md#runtime).

## The sandbox seam

Subprocesses (sensors, the bridge, modules, workers) are spawned through a `Sandbox` trait
(`src/sandbox/`). The default `HostSandbox` runs them directly; a `DockerSandbox` maps an isolation
policy to `docker run` flags. This is how delegated **workers** get OS-level isolation
(see [workers](workers.md)) and where future sensor/container hardening slots in.

## The soul repo

The agent's durable identity is a git repository — the **soul** — separate from this source tree
(cloned from a public template into its own repo). It holds the agent's prompts, memory, stimuli, and
skills. The harness commits to it under the agent's own DID (native Ed25519 — `LocalIdentity`, minted by
`dack keygen`; the only identity backend) and pushes it with a plain `git push` to one or more
configured git remotes (GitHub / self-hosted), so the agent's history is attributable to it. An
**integrity tripwire** reverts any change to the soul made outside a Reflect cycle, so self-modification
stays gated.

Opt-in **`soul_remote_authority`** makes `dack run` reconcile the local soul with the primary remote at
boot: remote-authoritative for everything except `soul_local_paths` (default `memory/`, the duck's own
memory). So you reconfigure a running duck by pushing config to its private soul repo and restarting.
It's safe — it skips a dirty tree, and a divergence snapshots local HEAD to a `pre-sync-<ts>` branch
before adopting the remote config and restoring local memory (`src/repo/gitcore.rs`).

See [authoring souls](authoring-souls.md) for the bundle layout and [operations](operations.md) for the
identity setup.

## Memory & digests

The agent has two memories (see [concepts](concepts.md#memory-short-term-vs-long-term) for the model):

- **Short-term** is the **runlog** (`src/runlog/`) — a single SQLite+FTS5 database `runlogs.sqlite`
  (config `runlog_db`) that lives **outside** the soul, in the harness working dir. It's harness-authored
  and append-only: one record per cycle plus a typed tag-notes catalogue. The agent can **never** write it
  and never reads the file directly; it reaches it only through two **recall** MCP servers (`recall-mcp/`,
  a separate bun/TS project) — `recall` (verbatim transcript, taints the cycle `public`) and `recall-self`
  (only the agent's own post-firebreak thoughts + tag-notes, does **not** taint); the trust boundary is at
  query + render. The recall surface also exposes discovery tools (search, by-tag, time-window) so a fresh
  or context-evicted session can reorient. Entries age off via a hard GC after `runlog_retention_days`
  (default `10`); `dack log` prints the tail; a one-shot `dack migrate-runlogs` converted the old markdown
  store (the `<soul>/runlogs/` markdown backend and its git repo are gone).
- **Long-term** is `memory/` in the soul — durable knowledge, **trust-gated** to `memory_write_min_trust`
  (default `org`) at the path gate. `protected_memory_paths` (e.g. `memory/INDEX.md`, injected into every
  context) are writable **only in Reflect** — a non-Reflect rewrite would be an injection surface, so the
  wall denies it.

The bridge between them is a **digest** — a scheduled, `self`-trust cron cycle (e.g. `activity-digest`,
`twitter-digest`) that perceives short-term memory via `recall-self` (staying clean) and consolidates the
durable parts (the runlog's tagged notes) into `memory/`, optionally surfacing suggestions to the operator
over Telegram. Digests are the *only* path by which conversation activity becomes long-term memory,
keeping `memory/` single-writer.

## Observability

Operational logging is structured (`tracing` → stdout, configured by `log`): each cycle is a correlation
span, every model call emits a latency + token-usage line, and lifecycle/scheduling/error events stream as
pretty text on a TTY or JSON when containerized. This is distinct from the runlog (the agent's memory); see
[operations](operations.md#observing-a-run).

A shared in-memory **`HealthRegistry`** (`src/health/`) tracks secrets, stimuli/duties, per-MCP-server
connect liveness, and cycle counts. It's read two ways: `dack status` (the operator's on-demand window, via
a daemon-written `dack.health.json`) and a trusted **`subconscious-health`** block in the Reflect prompt —
so the duck itself notices "my X token is dead" or "`cove-read` keeps failing to connect". Servers
unavailable to a given cycle (dead secret, taint-degraded, or a live connect-failure streak) are also
announced to the model in the orientation block's `unavailable_this_step`, so it stops guessing at absent
tools.

## Module map

| Module | Responsibility |
|---|---|
| `src/sources/` | cron wheel + webhook listener → one `FiredTrigger` channel |
| `src/sensor/` | run a duty's fetch script under a read-scoped sandbox |
| `src/bus/` | normalize → coalesce → seed trust → enqueue |
| `src/queue/` | embedded SQLite queue (durable, leased, coalescing, debounce) |
| `src/harness/` | the consciousness loop, dispatch, the wall integration, modules, workers, Reflect |
| `src/state/` + `src/state_prompt.rs` | consciousness states, tool classes, state-prompt parsing |
| `src/runtime/` | the `RuntimeClient` seam + the OpenClaude bridge driver + the wall responder |
| `src/sandbox/` | the `Sandbox` seam (host / docker) |
| `src/config/` | `dack.config.yaml` parsing + the trust lattice |
| `src/secrets/` | secrets-provider broker |
| `src/repo/` | the soul git host (plain `git push` → configured remotes) + boot-time remote reconcile |
| `src/identity/` | identity resolution + signing (native Ed25519 — `LocalIdentity`) |
| `src/runlog/` | the agent "syslog" — the SQLite short-term store (`runlogs.sqlite`) |
| `src/health/` | the in-memory health registry (`dack status` + the `subconscious-health` block) |
| `src/stimuli/` | duty (`STIMULUS.md`) registry + hot-reload |
| `src/webserver/` | the localhost webhook listener |
| `src/model/` | the core domain types (Stimulus, Baton, proposal, runlog) |

The design rationale behind these choices is documented inline — in the module-level doc comments
throughout `src/` and in the rest of this `docs/` tree.
