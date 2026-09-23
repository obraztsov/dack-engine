# Configuration reference

`dack.config.yaml` is the operator control plane: the single non-LLM authority surface. The harness
reads it; the agent may read selected fields but can never write it. It is hot-reloadable — most
changes take effect on the next dispatch without a restart.

Keep it **gitignored**. Secret *values* never live here — only references and provider definitions.
A starting point lives in [`dack.config.example.yaml`](../dack.config.example.yaml).

The only required field is `operator_did`. Everything else has a safe default.

```yaml
operator_did: "did:key:z6Mk…"
runtime:
  connector: { type: openai-compatible, api_url: "https://gateway.example/v1", api_key: "…" }
  model: "your-model-id"
```

---

## Identity & trust

| Field | Type | Default | Meaning |
|---|---|---|---|
| `operator_did` | string | **required** | The trusted operator DID. A `dack say` instruction is signed with the operator key and verified against this DID — that is what makes a stimulus `operator_signed`. |
| `trust_tiers` | list | `public→express`, `self→reflect`, `operator_signed→reflect` | The trust lattice (see [concepts](concepts.md)). Ordered low→high; rank = position. Each entry is `{ name, reaches }` where `reaches` is the highest consciousness state a cycle at that tier may walk to. The three names `public` / `self` / `operator_signed` must exist in any custom lattice. An unknown tier name fails safe (lowest rank). |
| `signed_scripts` | map | `{}` | Sensor-script provenance: `sha256(script-source-hex) → trust tier`. A sensor whose source hashes to a listed entry seeds its cycle at that tier; an unsigned or since-edited script seeds `public`. This is operator code-review-as-signing. |
| `webhooks` | map | `{}` | Per-webhook-path trust anchor: `"/path" → trust tier`. A stimulus arriving on a registered webhook path is seeded at that path's tier. An unlisted path seeds `public`. The localhost-only listener means only a local adapter can post. |

```yaml
trust_tiers:
  - { name: public, reaches: express }
  - { name: org,    reaches: settle }   # a custom tier between public and self
  - { name: self,   reaches: reflect }
  - { name: operator_signed, reaches: reflect }

webhooks:
  "/telegram/op":  org
  "/telegram/pub": public
```

---

## Capabilities (MCP servers)

`mcp_servers` is the registry of tools the agent can use. The agent can never add one — that would be
self-granting authority. See [capabilities](capabilities.md) for the full model.

Each entry:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | required | Server name. Its tools are addressed as `mcp__<name>__<tool>`. |
| `transport` | object | required | `{ type: stdio, command, args }` (a local process) or `{ type: http, url }` (a remote server). |
| `auth` | object | none | `{ secret, env?, key?, header?, scheme? }`. `secret` names a `secrets_providers` entry; its token is injected into the server's stdio `env` (named by `env`) or HTTP header (`header`/`scheme`, default `Authorization: Bearer`). The token reaches the server, never the agent context. |
| `tier` | enum | required | `read` (safe in every state), `post` (Express — reversible), or `settle` (Settle only — irreversible). The wall classifies the server's tools from this. |
| `tools` | list | `[]` | Per-server tool **whitelist** (bare names). When set, ONLY these are admitted: the wall denies any other tool under `mcp__<name>__` **fail-closed**. Use it to expose a read-only subset of an endpoint that otherwise serves write tools to every token. |
| `banned_tools` | list | `[]` | Per-server tool **blacklist** — the alternative to `tools`. **Precedence**: `tools` (whitelist, fail-**closed** — only listed tools admitted) wins if set; else `banned_tools` (blacklist, fail-**open** — everything admitted except these, so a tool the upstream server adds later auto-admits at this server's `tier`); else (both empty) admit everything. Prefer the fail-closed `tools` whitelist for irreversible/settle (money) servers. Both are the wall's **call-time** authorization, not what's announced — the SDK still exposes every connected tool; the wall denies at call time. |
| `trust` | tier | `self` | The taint label of the *data* this server puts in play. Calling any of its tools degrades the cycle's trust to (at most) this tier. Anything touching the public world must be `trust: public`. |
| `min_trust` | tier | none | Authorization floor: the server is only assembled for a cycle whose current (post-taint) trust ranks `>=` this tier. A high-trust cycle that degrades mid-walk loses the capability. |
| `scope_env` | map | `{}` | `{ ENV_VAR: payload_field }`. At assembly the harness reads `payload_field` from the waking stimulus and injects it into this server's env — locking the capability to per-cycle data the model can't supply (e.g. a reply destination). |
| `env` | map | `{}` | Static env for the server (non-secret operator config the server needs, e.g. a named-destination map). |
| `expand` | enum | `inline` | Tool-surface expansion: `inline` sends this server's tools up front; `deferred` holds them behind a `find_tools` search so a large surface doesn't bloat every prompt. **Runtime-gated** — honored only by the `duck-loop` runtime's client-side tool search; OpenClaude ignores it (all tools inline). A dack-engine config field, never sent to the server → backward-compatible. |

```yaml
mcp_servers:
  - name: twitter
    transport: { type: stdio, command: bun, args: [run, mcp/twitter-mcp.ts] }
    auth: { secret: x, env: X_BEARER_TOKEN }
    tier: post
    trust: public
  - name: cove-read
    transport: { type: http, url: "https://cove.example/api/mcp" }
    auth: { secret: cove_read }
    tier: read
    trust: self
    tools: [get_balance, get_positions, simulate_swap]
```

### `tier_policy` — the operator half of the capability handshake

A state-prompt requests servers in its `mcp:` frontmatter; `tier_policy` admits them. Keyed by
consciousness state (`perceive` / `express` / `settle` / `reflect`). An unconfigured state is locked
(nothing grantable).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `import` | list | `[]` | The `mcp_servers` names a state-prompt at this tier may import. |
| `deny` | list | `[]` | Names explicitly refused even if a prompt requests them. |
| `mcp_whitelist` | bool | `true` | `false` = an **open** tier: a state-prompt may also inline any public, secret-less read MCP (forced read-tier; it can never self-grant a post/settle tool). |
| `model` | string | global `runtime.model` | The operator's default model for this tier (the model split). |
| `allow_model_override` | bool | `false` | Whether a state-prompt at this tier may name its own `model:`. |

```yaml
tier_policy:
  perceive: { mcp_whitelist: false, import: [cove-read, twitter-read] }
  express:  { import: [twitter, telegram] }
  settle:   { import: [cove-trading, cove-read], model: "strong-model-id" }
  reflect:  { import: [], allow_model_override: true }
```

### `post_tools` / `settle_tools`

Tool-name prefixes the wall classifies independently of the registry — `post_tools` → `Post`
(Express), `settle_tools` → `SettleTx` (Settle only). They must stay disjoint. Defaults:
`post_tools: [mcp__twitter__]`, `settle_tools: [mcp__bankr__, mcp__dac__]`. Most deployments rely on
the registry `tier` instead and leave these alone.

---

## Secrets

The harness never stores secret values. Two mechanisms:

### `secrets_providers` — short-lived token materialization

A trusted, harness-owned script that fetches/rotates a token on demand and prints a JSON env map. A
duty or capability references it by name; the harness runs it and injects the result.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | required | Referenced from a duty's `secrets:`, a module's `secrets:`, or a capability's `auth.secret`. |
| `command` | list | required | The provider script argv (e.g. `["python3", "secrets-providers/x_oauth2.py"]`). |
| `env` | map | `{}` | Config (paths, refs) passed to the script — not secret values. |
| `keys` | list | `[]` | The env-var names the provider is expected to emit (documentation/validation). |
| `trust` | tier | `self` | The taint label of the data this secret puts in play. A secret that touches the public world (an X bearer) must be `trust: public`. |

### `secrets` — file references

A plain map of `name → reference` (e.g. `soul_did_key: "file:///run/secrets/soul_did_key"`). Resolved
by the harness; the Soul DID key in particular is harness-only and never forwarded to the agent.

### `forwarded_env`

A list of env-var **names** injected into the agent and sensor environment (values come from the
harness process env, never the YAML). Reserved for recoverable values (API keys, handle, limits) — a
leak means rotate, not catastrophe. The Soul DID key is deliberately never listed here.

See [secrets & sandboxing](secrets-and-sandbox.md) for the full secret model.

---

## Channels (`modules`)

`modules` is the supervisor for long-running side processes — channel adapters that carry normalized
events to the harness's localhost webhook. The harness spawns each enabled module at boot, injects its
declared secrets, and restarts it with backoff until shutdown. See [channels](channels.md).

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | required | Stable id for logs. |
| `command` | list | required | argv (e.g. `[bun, run, mcp/telegram-ingress.ts]`). |
| `secrets` | list | `[]` | Secrets-provider names whose env is injected, resolved fresh on each restart. |
| `env` | map | `{}` | Static env (paths, ids, flags). |
| `cwd` | string | the harness process cwd | Working directory for the module. |
| `enabled` | bool | `true` | `false` ⇒ declared but not started. |

```yaml
modules:
  - name: telegram-ingress
    command: [bun, run, mcp/telegram-ingress.ts]
    secrets: [telegram_bot]
    env: { TELEGRAM_INGRESS_CONFIG: telegram-ingress.config.json }
```

---

## Runtime

The engine + connector extensibility point. Swapping runtime/provider is one config edit.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `runtime.engine` | object | `{ type: openclaude, bridge_dir: openclaude-bridge }` | Which agent runtime drives the loop. `openclaude` (default) spawns `bun run bridge.ts`; `bridge_dir` is the bridge project directory. `duck-loop` selects the project's **own** in-house agent-loop runtime (same NDJSON protocol + same connector env) — experimental: text cycles work, MCP tools + the wall are still being brought to parity, so it is not the default. `claude-code` (the Claude Code CLI/SDK directly) is a documented future variant, not yet wired. |
| `runtime.connector` | object | `{ type: openai-compatible }` | How the engine reaches models. `openai-compatible` (renamed from `opengateway` — the old `type: opengateway` still parses via a serde alias) is an OpenAI-compatible env shim: `{ api_url, api_key, api_format? }` → `OPENAI_BASE_URL`/`OPENAI_API_KEY` (both optional; `None` falls back to the harness env), plus it sets `CLAUDE_CODE_USE_OPENAI=1`. Point `api_url` at any OpenAI-compatible endpoint (a hosted gateway, provider-direct, a local vLLM). `anthropic` (`{ api_key }`, native catalog) parses but is a **NotImplemented stub** (`cli::run` rejects it). |
| `runtime.connector.api_format` | enum | `chat_completions` | Which OpenAI surface the connector targets: `chat_completions` (`/chat/completions`, the default) or `responses` (the newer `/responses` — reasoning as first-class items). `responses` is an experiment; validate on a throwaway per provider before enabling. |
| `runtime.model` | string | none | The default model id. `tier_policy.<tier>.model` overrides it per state. On `openai-compatible` the per-state model is routed via the child's `OPENAI_MODEL` env (the SDK rejects a gateway name as `options.model`). |
| `runtime.vision_models` | list | `[]` | Model ids that accept **image** input. An image-bearing Perceive keeps its selected model if that model is already a vision model, else routes to `default_vision_model`. Omit both ⇒ images are not ingested. |
| `runtime.default_vision_model` | string | none | The model an image-bearing cycle routes to when the selected model isn't in `vision_models`. |
| `runtime.env` | list | `[OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL, …]` | Extra env-var names forwarded into the runtime bridge (values from the harness env). The connector's own creds are applied on top. |

> **Sticky sessions on `duck-loop`.** When the `duck-loop` engine is selected the harness wires
> `DUCK_SESSION_DB` so sticky sessions (resume-by-id) persist across cycles, and `mcp_servers` supports
> `expand` (deferred tool loading) — see the Capabilities table.

### `runtime.worker_sandbox` — Docker isolation for delegated workers

See [workers](workers.md). When enabled, an async worker whose agent def declares `isolation: docker`
runs its bridge inside a container.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | bool | `false` | `false` ⇒ workers run on the host. |
| `image` | string | `""` | The pre-built worker image (built from `Dockerfile.worker`). |
| `memory` | string | `2g` | Container memory cap. |
| `pids_limit` | int | `256` | Container PID cap. |
| `require` | bool | `true` | When Docker/the image is unavailable: `true` ⇒ hard-fail boot (the safety claim holds); `false` ⇒ warn + fall back to host. |

---

## Soul repo & push destinations

The soul is one local git repo (`soul_repo`); `soul_remotes` is the list of **plain-git** remotes it's
pushed to after each cycle. There is no other backend — every target is a plain `git push`. Each is
best-effort unless `required: true`, so a flaky mirror never blocks a cycle.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `soul_repo` | string | `.` | Path to the actor bundle (holds `SOUL.md`, `prompts/`, `stimuli/`, `memory/`, …). |
| `soul_remotes` | list | `[]` | Plain-git push destinations (see entry fields below). Empty ⇒ fall back to the legacy `soul_remote`; if that's unset too, local-only (commits, no push). |
| `soul_remote` | string | none | **Legacy** single remote (a bare URL string). Still honored — normalized to a one-element best-effort `soul_remotes` list. Prefer `soul_remotes`. |
| `soul_remote_authority` | bool | `false` | **Remote-authoritative boot reconcile**: when `true`, `dack run` reconciles the local soul with the primary remote at boot — adopt config an operator pushed externally, keep the duck's own local memory — so you reconfigure a duck by pushing + restarting. Always safe (skips a dirty tree; a divergence first snapshots local HEAD to a `pre-sync-<ts>` branch). Default `false` = local-authoritative (no boot fetch). |
| `soul_local_paths` | list | `["memory/"]` | The duck-OWNED paths kept LOCAL during a `soul_remote_authority` reconcile — everything else is adopted from the remote. |
| `identities` | object | `{}` | Identity key directories per role: `operator`, `soul`, `builder` (each holds a PKCS8 `identity.pem`). Create with `dack keygen --role <role> --dir <dir>`. The operator key signs `dack say`; the Soul dir attributes soul commits and never enters agent env. |
| `identities.backend` | `local` | `local` | Signing/DID backend — native Ed25519, the only backend: reads `identity.pem` directly and signs in-process, no external tools. Keys are made with `dack keygen`. (The former `gitlawb` backend that shelled out to a `gl` CLI is removed.) |
| `secrets.soul_did_key` | ref | — | Reference to the Soul DID key (resolved by the harness; never forwarded to the agent). |

### `soul_remotes[]` — one push destination

| Field | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | — | The plain-git push URL — `git@host:…` (SSH), `https://…`, or a local path. Always a plain `git push`. |
| `required` | bool | `false` | `true` ⇒ a push failure to this target fails the cycle's push step. `false` ⇒ best-effort (logged, re-pushed next cycle). Set `true` on the primary you require to durably persist the soul. |
| `auth` | object | none | HTTPS token push only — `{ token_env, username? }`. `token_env` names an env var in the **daemon's** environment holding the access token (e.g. a GitHub PAT), injected as an ephemeral git credential at push time; never in config, disk, argv, or agent context. `username` defaults to `x-access-token`. SSH remotes (`git@…`) need no `auth` (the ambient key authenticates). |

```yaml
soul_remotes:
  - { url: "git@github.com:you/dack-soul.git", required: true }   # SSH primary
  - url: "https://github.com/you/dack-soul.git"                   # HTTPS mirror
    auth: { token_env: GITHUB_TOKEN }                             # PAT from the daemon env
```

GitHub (or any plain-git host) transport auth is **independent of the soul DID** — the DID is the
commit author; you authenticate the push with an SSH deploy key (no `auth` needed) or an HTTPS PAT via
`auth.token_env`. See [operations → pushing to a GitHub remote](operations.md#pushing-to-a-github-or-any-plain-git-remote).

---

## Behavior & operations

| Field | Type | Default | Meaning |
|---|---|---|---|
| `default_entry` | string | `perceive` | The state-prompt id harness-synthesized stimuli enter at (the `dack say` instruction, the boot back-online ping). |
| `reflect_schedule` | cron | none | Cron for the scheduled Reflect run (e.g. `"0 4 * * *"`). Omit for manual `dack reflect-now` only. |
| `reflect_min_interval_secs` | int | `86400` | Minimum seconds between Reflect (self-modification) runs — enforced for both the scheduled and any transition-reached Reflect. `0` disables. |
| `session_ttl_secs` | int | `3600` | Idle seconds before a sticky engine session is dropped. `0` = never evict. |
| `queue_max_depth` | int \| null | `10000` | Load-shedding cap: max pending queue depth before the **oldest `Low`-priority** items are evicted (Normal+ is the protected floor, never shed; each eviction is logged). `null` = unbounded. Protects against a runaway low-priority fan-out backlog. |
| `baton_ttl_secs` | int \| null | `null` | A deferred baton continuation older than this many seconds is **expired** (dropped + logged) at dispatch instead of acting on a stale context. `null` = never expire by age. |
| `db_path` | string | `dack.sqlite` | The embedded SQLite queue path (ephemeral — losing it loses only the queue). |
| `webhook_addr` | string | `127.0.0.1:8787` | The localhost bind for the webhook listener. Nothing is public without a proxy. |
| `invoke_timeout_secs` | int | `300` | Wall-clock budget for one consciousness invocation incl. the wall round-trips. A hung LLM/bridge elapses here. A **zero-completion timeout** (the model did nothing) is then re-scheduled up to 3× with backoff — *unless* the wake already took an outward action (post/trade) or was a Reflect, which fail terminally to avoid a double-effect. |
| `reflect_invoke_timeout_secs` | int \| null | `null` | Optional **longer** budget (seconds) for a **Reflect** invocation (the daily self-modification cycle — may chew through prompts/skills/memory), e.g. `900` = 15 min. `null` ⇒ Reflect uses `invoke_timeout_secs`. Applies only to Reflect. |
| `notify_url` | string \| null | `null` | The **op-notify** router endpoint (e.g. `http://127.0.0.1:8794/notify`). When set, the harness POSTs to it on two triggers: a **terminal dispatch failure** (severity `error`) and a **silent cycle** (severity `alert`) — a cycle entering a prompt with `notify_on_silent: true` frontmatter that produced zero outward tool calls **and** zero batons (a reply that died in a thought). Fire-and-forget, timeboxed — the failure-reporting lane never becomes a failure mode. This is the operational **error trail**, NOT a messaging lane (a client reply is a normal SEND baton). Delivery/routing (telegram/buzz/log) lives in the `notify-router` module + its `notify.config.json`. `null` = off. See [Channels → op-notify lane](channels.md#op-notify-lane-operational-error-trail). |
| `session_max_context_tokens` | int \| null | `null` | Evict a sticky engine session once its model context (input + cache-read tokens) exceeds this many tokens (the next wake starts fresh) — bounds context bloat. `null` = off (only the idle TTL applies). A common setting is `120000`. |
| `max_concurrent_cycles` | int | `1` | **Multithreading** — the bounded worker-pool size for the dispatch loop. `1` (default) = single-flight, byte-identical to the pre-MT serial behavior. `>1` runs independent wakes in parallel: different chats concurrently, but a same chat still serializes (one in-flight wake per `dedup_key`), and write-lock cycles (settle / reflect / digest) run exclusively. A prompt opts into parallelism with `parallel: true` frontmatter (memory + soul are read-only → it takes a shared read-lock; every other cycle takes the exclusive write-lock). Bound it by the model gateway's rate/cost, not CPU. |
| `memory_write_min_trust` | string | `org` | Trust floor for writing **long-term `memory/`**. A cycle below this tier is denied the write (it can still leave a short-term tag-note). Keeps untrusted in-run cycles from laundering into long-term memory; the digest jobs run at `self` and clear it. |
| `protected_memory_paths` | list | `[]` | Long-term `memory/` paths (repo-relative, e.g. `memory/INDEX.md`) writable ONLY in Reflect — like `SOUL.md`/`prompts/`/`stimuli/`. These files are engine-injected into every context, so a non-Reflect cycle (even org+) rewriting them would be a context-injection surface; the wall denies it. A plain path matches exactly; a trailing-`/` entry protects a whole subtree. |
| `runlog_db` | string | `runlogs.sqlite` | The **short-term memory** store — a SQLite + FTS5 database (NOT markdown/git), in the harness cwd, outside the soul. Separate from the queue `db_path`. Losing it loses only short-term memory (prompts + long-term `memory/` are durable); a fresh one is created on boot. Read-only to the recall MCPs. |
| `runlog_retention_days` | int | `10` | **Short-term memory retention**: runlog entries age off (are deleted) after this many days — also bounds how far back the recall tools can scan. |
| `runlog_hard_days` | int | `30` | Hard-GC ceiling: delete runlog entries older than this (the multi-GB guard, above the smaller surfaced window). Large by design. |
| `tag_notes_max` | int | `200` | Cap on the short-term **tag-notes** catalogue: only the last N notes are kept (the read tool dedups to latest-per-tag anyway). |
| `tag_note_hard_days` | int | `90` | Hard-GC ceiling: delete any tag-note older than this. Large by design. |
| `runlog_remote` | object | none | Optional push destination for the runlogs' own **private** git repo (kept out of the public soul because runlogs carry chat detail / handles). Same shape as a `soul_remotes` entry (`url` / `auth` / `required`). `None` ⇒ local-only. |

### `log` — structured logging

Operational logging via the `tracing` framework, written to **stdout** (so `docker logs` / an operator
backend can capture it). Distinct from the runlog (which is the agent's own memory). `RUST_LOG` overrides
`level` for per-module control (e.g. `RUST_LOG=dack::harness=debug`).

```yaml
log:
  level: info     # trace | debug | info | warn | error
  format: auto    # auto (pretty TEXT on a TTY, JSON when piped/containerized) | text | json
```

Each cycle's log lines carry a correlation span (`cycle{stim=…}`), and every model call emits a latency
line (`elapsed_ms`, token counts) — so a run is traceable end-to-end, and ready for the upcoming
concurrent scheduler.

### `dry_run`

A testing switch: when `enabled`, the wall denies any tool whose name starts with a `block` prefix —
the agent composes the action (visible in the runlog) but it never executes. Tool-level and uniform
across every MCP, so a no-real-trade run can still allow reads and `simulate_swap`.

```yaml
dry_run:
  enabled: true
  block: [mcp__twitter__post, mcp__twitter__reply, mcp__cove-trading__buy_token]
```
