# Channels (talking to the world)

The harness reaches the outside world through two seams that stay cleanly separated from the core:

- **Inbound** events arrive as POSTs to the localhost webhook listener, each on a path whose configured
  trust tier seeds the resulting cycle.
- **Long-running channel adapters** (a Telegram long-poll loop, a websocket client) run as **modules** —
  side processes the harness owns: it spawns them, injects their secrets, and keeps them alive.

The core harness never parses a channel protocol. An adapter normalizes its protocol into a generic
webhook POST; the harness only sees "a localhost webhook fired at tier X." This keeps channel
specifics out of the trust-critical code.

## Webhook trust anchors

`config.webhooks` maps a webhook path to the trust tier a stimulus on that path is seeded at:

```yaml
webhooks:
  "/telegram/op":      org       # the operator's own messages
  "/telegram/trusted": org       # a vetted group
  "/telegram/pub":     public    # strangers, public groups — reply-only, can't trade
```

The path is the provenance contract the wall enforces. The agent cannot write `config.webhooks`, and
the listener is localhost-only — so only a local adapter can post, and the tier is the operator's call,
not the sender's. A duty (`stimuli/*/STIMULUS.md`) with `trigger: { type: webhook, path: … }`
registers the route; the POSTed body becomes the stimulus payload.

## Modules (the supervisor)

A **module** is operator-trusted plumbing declared in `config.modules`. At boot the harness spawns each
enabled module, injects its declared secrets (resolved fresh on every restart, so a rotated token is
picked up), and supervises it: an exited child is restarted with exponential backoff (1s→30s; a child
that stays up resets the curve), and on shutdown every child is killed.

```yaml
modules:
  - name: telegram-ingress
    command: [bun, run, openclaude-bridge/telegram-ingress.ts]
    secrets: [telegram_bot]          # injects TELEGRAM_BOT_TOKEN
    env: { TELEGRAM_INGRESS_CONFIG: telegram-ingress.config.json }
```

This is the single-config contract for hosting: one `dack run` starts the agent's whole runtime — its
mind *and* its channels. A module touches no trust lattice; it only carries normalized events to the
webhook, where the trust contract applies. Adding a channel is a `modules:` entry, a webhook
path→tier, and the adapter script — never a harness change. See
[configuration](configuration.md#channels-modules) for the fields.

## The bundled Telegram adapter

`openclaude-bridge/` ships a reference Telegram integration in three pieces, illustrating the pattern.

### Ingress (a module)

`telegram-ingress.ts` long-polls the bot, decides each message's trust by **who sent it** using its own
config (not the harness), and POSTs a normalized message to the matching webhook path. Routing
precedence (`routeFor`):

1. the operator's user id (anywhere) → the operator path,
2. a known/trusted group's chat id (a `groups` map in the adapter config) → that group's path,
3. **(opt-in)** a chat-type split on `chat.type`: a non-operator **private** chat → `dm_path`, a
   non-trusted **group** → `group_path`,
4. everyone else → the public path.

The chat-type split (step 3) is opt-in — `dm_path` and `group_path` each fall through to `pub_path`
when unset, so an existing single-webhook config is unchanged. It lets private clients and public
groups land on **different entry prompts + MCP sets** (still the same `public` tier). It needs **no
engine change**: the path→trust→entry-prompt chain is fully data-driven — add a `webhooks:` entry and
a `STIMULUS.md` per path.

The adapter's config (`telegram-ingress.config.json`, operator-owned and gitignored) is where the
Telegram-specific rails live — chat/user → webhook path. The harness only knows path → tier.

Its format (every key optional; defaults shown — the file it reads comes from the module's
`TELEGRAM_INGRESS_CONFIG` env, else `telegram-ingress.config.json`):

```json
{
  "harness_webhook": "http://127.0.0.1:8787",
  "operator_user_id": 111111111,
  "op_path": "/telegram/op",
  "pub_path": "/telegram/pub",
  "groups": { "-1001234567890": "/telegram/trusted" },
  "dm_path": "/telegram/dm",
  "group_path": "/telegram/group"
}
```

- `harness_webhook` — base URL of the harness listener (match `webhook_addr`).
- `operator_user_id` — your Telegram numeric user id; a message from it (in any chat) routes to
  `op_path`. `null`/omitted = no operator recognition.
- `groups` — a `chat_id → webhook path` map; a message in a listed group routes to that path.
- `op_path` / `pub_path` — operator and fallback (everyone-else) paths.
- `dm_path` / `group_path` — **optional** chat-type split: a non-operator private chat → `dm_path`, a
  non-trusted group → `group_path`; each falls through to `pub_path` when omitted.

Routing per message: operator id → `op_path`; else a `groups[chat_id]` hit → that path; else the
chat-type split (`dm_path` for a private chat / `group_path` for a group, when set); else `pub_path`.
Each path's **trust tier** is set by `config.webhooks` in `dack.config.yaml` (above), never here. The
adapter needs the bot token in its env (`TELEGRAM_BOT_TOKEN`, injected via the module's
`secrets: [telegram_bot]`; it also falls back to `secrets/telegram.token`). Each POST it sends carries
`{chat_id, message_id, text, from_username, from_user_id, chat_type, sent_at, dedup_key}` — where
`dedup_key` (the chat id) is the per-conversation coalescing key.

### Egress — reply (destination-locked)

`telegram-mcp.ts` is an MCP server exposing one tool, `reply{text}`. The harness injects the source
chat into its env via `scope_env`, so the model passes only the text and physically cannot reach any
other chat. This is open to any tier — a public stranger can be answered in their own thread, and
nowhere else.

### Egress — proactive send (authorized)

`telegram-send-mcp.ts` exposes `send_message{to, text}` for proactively messaging a destination the
duck **chooses** (no inbound message). It is gated `min_trust: org`, so a public/stranger cycle never
gets it — no one can prompt-inject the agent into spamming the operator's group.

`to` resolves fail-closed against `TELEGRAM_DESTINATIONS` (operator-owned static env). The shape is
backward compatible:

- the **legacy flat** map `{ "name": chat_id }` = **named** destinations only (a symbolic name → id);
- the **structured** form `{ named: {..}, groups: [..], allow_known_private: bool }` adds two rails:
  explicit **group** chat_ids in `groups`, and — when `allow_known_private` is set — a private **user**
  chat_id that is a **known contact**, verified against the runlog (a telegram-sourced entry tagged with
  that chat_id).

An unknown / hallucinated / injected chat_id that matches none of these is **denied** (sends nothing).
So a CEO-style duck can DM clients it has actually talked to, but can never be tricked into DMing a
stranger it has never heard from.

Together these mirror the general pattern for any channel: a destination-locked reply that's open to
everyone, and an authorized proactive send that's gated by trust. See
[capabilities](capabilities.md#locking-a-capability-to-per-cycle-data-scope_env) for the `scope_env`
and `min_trust` mechanisms.

## The bundled Twitter/X integration

X is reached as MCP capabilities rather than a long-running module — inbound is a polling sensor, egress
is a small set of MCP servers, and the same trust split applies.

- **Inbound** — a duty's fetch script (`stimuli/*/STIMULUS.md`) polls mentions / a thread and emits a
  stimulus. Incoming tweets seed `public`, so reading them taints a cycle and it can only *reply*, never
  trade or self-edit on the strength of a stranger's tweet. In Perceive the agent can also pull X context
  on demand via the read server.
- **Egress — write (`twitter-mcp.ts`)** — exposes `post`, `reply`, and the deliberate amplification tools
  `retweet` / `unretweet` / `quote_tweet`. These are **Post**-class (Express only) and the amplification
  tools are listed in `dry_run.block`, so they are previewed (logged, not sent) until the operator clears a
  specific action — amplification is meant to be rare and considered.
- **Egress — read (`twitter-read-mcp.ts`)** — content reads: `get_user`, `get_user_tweets`, `get_thread`,
  `get_tweet`, `search_recent`, `get_liking_users`. A `public` capability (it returns tweet text): useful
  for context but it taints, so a digest that calls it cannot then write long-term memory in the same cycle.
- **Graph — read (`twitter-graph-mcp.ts`)** — the duck's own social graph: `get_followers` / `get_following`,
  returning **only** `{id, username, name}` per user (no bio, no tweet text). Because it carries no free
  text to smuggle an injection it is registered **`trust: self`** — so the `twitter-digest` can diff "who
  newly followed me / who I follow" and *still* write it to long-term memory in the same cycle.

**There is deliberately no follow tool.** Following is a stronger social signal (and an account-risk
surface) that stays a human decision: the `twitter-digest` job, when it spots an account worth following,
*suggests* it to the operator over Telegram (`telegram-send`), and the operator follows manually. See
[concepts](concepts.md#memory-short-term-vs-long-term) for the digest pattern and
[capabilities](capabilities.md) for the trust classes.

## Op-notify lane (operational error trail)

The **notify lane is not a messaging channel** — it is a separate operational/error TRAIL for things a
human should hear about *going wrong*. Talking to a person (a client reply, a heads-up to a group or
another agent) is a normal **SEND**: multi-baton fan-out already lets one cycle reply the client *and*
ping a group over telegram/buzz. The notify lane is the parallel audit + alerting path, with its own
routing, dedup, and durable log.

**Three producers feed one router:**

- The harness **`notify_url` hook** — a terminal dispatch failure the harness gives up on POSTs
  `severity:"error"`.
- The **swallowed-answer detector** — a cycle entering a prompt whose frontmatter sets
  `notify_on_silent: true` that finishes with zero outward tool calls **and** zero batons POSTs
  `severity:"alert"` ("a reply may have died in a thought"). Opt-in per prompt (default off) so a
  housekeeping/self-tier cycle can watch itself too, not just human-facing states.
- The **`notify` MCP** (`mcp/notify-mcp.ts`) — the model's own hand: `notify{severity, title?, message}`
  where severity is `error` / `alert` / `info`. Its destinations are operator config (there is no
  destination argument), so it is safe to grant to any cycle — there is nothing to hijack. Durable-first:
  it appends a local jsonl before POSTing, so a down router loses nothing.

**The router (`mcp/notify-router.ts`, a module)** delivers by severity. `severity_routes[sev] → [connector]`
and each connector carries its OWN targets, so one severity can fan to telegram **and** a buzz ops-channel:

```json
{ "severity_routes": { "error": ["telegram", "buzz"], "alert": ["telegram"], "info": ["log"] },
  "telegram": { "chat_ids": [111111111] },
  "buzz": { "channels": [], "relay": "https://buzz.a.pond.city" },
  "dedup_window_sec": 600, "hourly_cap": 20, "audit_jsonl": "notify-audit.jsonl" }
```

Connectors: `telegram` (Bot API), `buzz` (the buzz CLI + the `buzz_key` secret → `BUZZ_PRIVATE_KEY`),
and `log` (jsonl-only — **everything** is audited regardless of routing). Live-incident hygiene is built
in: a **dedup window** (one brownout ≠ 50 identical pings), a **rolling hourly cap** with a *one-time*
"storm suppressed → log only" notice (silent suppression is how operators stop trusting a lane), and a
jsonl audit of every notification, delivered or not.

Wire it as a module + the `notify` MCP + the top-level `notify_url`, and drop a `notify.config.json`
(see `notify.config.example.json`) beside the daemon:

```yaml
modules:
  - name: notify-router
    command: [bun, run, mcp/notify-router.ts]
    secrets: [telegram_bot, buzz_key]
    env: { NOTIFY_CONFIG: notify.config.json, BUZZ_BIN: /usr/local/bin/buzz, BUZZ_RELAY_URL: "https://buzz.a.pond.city" }
mcp_servers:
  - name: notify
    transport: { type: stdio, command: bun, args: [run, mcp/notify-mcp.ts] }
    env: { NOTIFY_URL: "http://127.0.0.1:8794/notify" }
    tier: post
    scope_env: { NOTIFY_SOURCE_CHAT: chat_id }   # provenance only — destinations stay operator config
notify_url: "http://127.0.0.1:8794/notify"
```

## Coalescing a busy channel

A high-volume channel (a group with read-everything enabled) can flood the single-flight loop. A duty
can fold a burst into one wake with a `coalesce` policy in its `STIMULUS.md` frontmatter, keyed per
chat (`dedup_key`) and debounced — so the agent wakes once on "the conversation since I last looked,"
not once per message.

Instead of a flat `window_sec`, a `batch` policy can set an **`adaptive`** window: a per-chat daily
**credit** budget (one credit = one wake) that *grows* the debounce as a chat spends it — snappy while
there's budget, then ×10 each time the chat burns half its remaining credits (capped at
`max_window_sec`). A normal chat never leaves `initial_window_sec`; only a noisy one throttles itself,
with a per-chat daily cost ceiling. It's frontmatter-configurable, so the duck can tune its own
responsiveness in Reflect. See [authoring souls](authoring-souls.md#coalescing).
