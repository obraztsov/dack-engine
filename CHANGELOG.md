# Changelog

All notable changes to dack-engine are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-09-23

A large release over 0.1.0: short-term memory moved to SQLite, the dispatch loop became
multithreaded, the agent gained **executable skills** and **bidirectional attachments**, three
channels (Buzz, multimodal Telegram, email) landed, and a separate **operational-notification**
lane was added. Identity went fully native (the external decentralized-git dependency was
removed) and the runtime/connector layer became a real extensibility seam.

> Being prepared as a **release candidate** — the feature set is complete and unit-tested; a
> live integration test is the remaining gate before a tagged release.

### Removed

- **In-duck subagent workers** (async Docker workers, sync sub-helpers, `agents/` definitions,
  `worker_sandbox`) — delegation is to Buzz agents; see `docs/design/workspace-and-documents.md`.

### Memory

- **Short-term memory is now a SQLite + FTS5 store** (`runlogs.sqlite`), replacing the old
  markdown/git runlogs. Full-text recall is served by separate `recall-mcp` servers split by
  trust (public vs self), with the trust boundary enforced at query + render time.
- **Typed short-term notes** — `memory` vs `digest` note kinds with auto-tagging; the nightly
  digest consolidates tagged short-term notes into long-term `memory/` and retires them.
- **Short-term vs long-term split** — the runlog is append-only and ages off; long-term `memory/`
  is written only via the digest (the old `memory_append` was removed). Retention, hard-GC
  ceilings, and a tag-notes cap are all configurable.
- **Runlogs live in their own private git repo**, gitignored by the public soul (chat detail /
  handles must not reach a public history), with optional push and boot-time re-clone on
  corruption.

### Dispatch & scheduling

- **Multithreading** — independent conversations process concurrently (`max_concurrent_cycles`);
  a single conversation still serializes (one in-flight wake per `dedup_key`), and any
  memory/soul-writing cycle takes an exclusive write-lock. A prompt opts into read-parallelism
  with `parallel: true` frontmatter.
- **Multi-baton fan-out** — one cycle can emit several intent-batons (reply the client *and* ping
  a group), each carrying its own taint. `priority: low` batons defer to the durable queue so a
  higher-priority stimulus preempts; load-shedding evicts the oldest low-priority work over a cap.
- **Adaptive coalescing** — a busy channel folds a burst into one wake, with a per-chat daily
  "credit" budget that grows the debounce window as a chat spends it (frontmatter-tunable).

### Executable skills

- **Signed skill packages** — a skill is a directory with a `skill.manifest.yaml` and a detached
  Ed25519 signature. The signature is the *execute-gate*: an unsigned, tampered, or wrong-signer
  manifest is prose-only (readable, never runnable). Sign with `dack skill sign`.
- **`RunSkillCommand`** — a structured tool (not a shell): fixed argv templates with typed holes
  (`String`/`Enum`/`Ref`/`Attachment`), tier/taint-gated at the wall exactly like an MCP
  capability. `${SKILL_DIR}` and a harness-fixed `${MEDIA_OUT}` are the only substitution tokens.
- A **reference `skills/buzz/` pack** ships with the engine (`media_get`, destination-locked
  `reply`, and `send_file` for outbound attachments).

### Channels — Buzz (Nostr)

- **`buzz-ingress` module** — discovers the duck's channels, polls history, detects mention /
  reply-to-own wakes, reconstructs the thread spine, and posts normalized stimuli.
- **Media vision** — Buzz `imeta` attachments surface as awareness on wake, with opt-in thumb/full
  prefetch; the duck pulls full-res on demand via the `media_get` skill (Blossom signed-GET →
  vision block).

### Channels — Telegram (multimodal)

- **Images** — inbound photo ingest with automatic routing to a vision model
  (`runtime.vision_models` / `default_vision_model`); an image-bearing Perceive never becomes a
  sticky session.
- **Voice** — ingress-side transcription (ffmpeg + a MiMo ASR endpoint) with a per-user daily cap.
- **Per-chat attachment permissions** the duck can author itself; a **typing indicator** that
  reflects real processing; **deep-link referral** capture (`?start=…`); **multi-operator**
  ingress (`operator_ids[]`, with legacy single-operator fallback).

### Attachments (both directions)

- Channel-agnostic contract: inbound `payload.attachments` (stored files), outbound by
  `attachment_id` / `{type: attachment}` — a **basename** the harness confines to the media dir
  (basename + realpath + store-prefix + regular-file), so an outbound file can only ever be a
  *stored* file. The confinement is shared by the TypeScript (`mcp/attachments.ts`) and Rust
  (`skills::confine_attachment`) egress paths.
- **Telegram** — ingest documents sent "as a file" (`m.document`); reply with a file
  (`reply_document`). **Buzz** — document inbound (routable stored `file`); outbound via the
  `send_file` skill command.

### Channels — Email (new)

- Outbound `reply_email` MCP (destination-locked recipient, provider-agnostic Resend-shaped API);
  inbound `email-ingress` module (constant-time shared-secret auth, attachments → media dir);
  a Cloudflare Email Worker template that parses inbound mail and posts to the ingress.

### Operational notifications

- A **separate notify lane** — operational error/alert/info reporting with its own durable trail,
  distinct from messaging (a client reply stays a normal send baton). A `notify-router` module
  routes per severity to Telegram / a Buzz ops-channel / a jsonl log, with dedup, an hourly cap,
  a one-time storm notice, and full audit. Producers: the `notify` MCP, the harness `notify_url`
  failure hook, and a **swallowed-answer detector** (`notify_on_silent` prompt frontmatter — fire
  when a cycle produces zero outward actions and zero batons).

### Health & observability

- A **subconscious health registry** (secrets, stimuli, cycles, MCP liveness) surfaces a trusted
  health block in the Reflect prompt and backs `dack status`. Taint/fault-unavailable and
  failed-to-connect MCP servers are **announced in orientation**, so the model stops confabulating
  tool names.

### Identity, soul & pond

- **Native Ed25519 identity** (`LocalIdentity` + `dack keygen`) is the only identity backend; the
  external decentralized-git runtime dependency is gone.
- **Remote-authoritative soul reconcile** (opt-in) — reconfigure a duck by pushing config to its
  remote and restarting; local memory is preserved, divergence is snapshotted, a dirty tree is
  skipped.
- **pond-manager** — a duck-as-CEO surface over the pond (`pond-management` MCP + signed envelope
  + leader ingress), with async create and host-level verb batching.

### Runtime, connectors & deployment

- Connector `opengateway` renamed to **`openai-compatible`** (with a serde alias); a new
  `runtime.connector.api_format` toggle (`chat_completions` | `responses`).
- **`duck-loop` engine seam** — an experimental in-house agent-loop runtime selectable via
  `runtime.engine`, with persistent sticky sessions (`DUCK_SESSION_DB`) and config-driven tool
  deferral (`mcp_servers.expand`). OpenClaude remains the default engine.
- **Containerized, multi-duck deployment** — one image (code), a directory + volume per duck.
- Reference MCP servers and channel adapters were split into `mcp/` (the bridge is now just the
  runtime bridge); the vendored OpenClaude SDK was re-built from the project's 0.18.0 fork.

### Capabilities & wall

- `banned_tools` — a blacklist alternative to the `tools` allowlist on an MCP server.
- Telegram chat-type routing (private vs group) and a `telegram-send` wildcard to known private
  contacts, both backward-compatible.

### Fixed

- Leniency-complete model-output boundary — no model field shape can silently drop a cycle.
- Globally-unique stimulus ids — same-second cross-chat webhook posts are no longer dropped.
- Reflect scheduler no longer double-fires at the day boundary.
- Digest notes deliver on consolidation (not on the read cycle); recall-self gained time-window
  querying; a durable per-attempt `send_audit` records delivery ground truth.

### Removed

- The gitlawb decentralized-git backend (identities, remotes, `gitlawb://`) — fully removed.
- `memory_append` (long-term memory is digest-written); the `allow_settle` flag (gated by the
  taint ceiling + cove limits instead).

## [0.1.0]

Initial harness: the ingestion → consciousness loop (Perceive / Express / Settle / Reflect), the
trust/taint wall, MCP capabilities, Telegram and X channels, delegated sandboxed workers, and a
signed soul git repo.
