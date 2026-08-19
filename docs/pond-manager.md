# pond-manager — the duck as the pond's CEO

The duck's end-to-end management surface over pond hosting: **MCP** (leader `/v1/manager` verbs),
the **envelope** (secret-handle passthrough, PRD §6.6), and **ingress** (leader stimulus socket →
duck wakes). Spec: `../../dack-leader/docs/dack-manager-handoff-v0.1.md`; product:
`../../dack-pond/pond-prd-v0.7.md` (§6, §12, §13).

All three are TypeScript companions in `mcp/`, riding existing engine seams — **no Rust change**:

| Piece | File | Engine seam |
|---|---|---|
| MCP server `pond-management` | `mcp/pond-mcp.ts` | `mcp_servers` stdio entry + `scope_env` |
| Leader client | `mcp/pond-leader.ts` | (library) |
| Handle store + cursor | `mcp/pond-store.ts` | tables in the shared `INGRESS_DB` SQLite |
| Resolve+splice | `mcp/telegram-mcp.ts` `reply` | the destination-locked telegram path |
| WS ingress | `mcp/pond-ingress.ts` | `modules:` supervisor + `webhooks:` path |

## The trust model, engine-shaped

- **The acting user is never a model argument.** `scope_env: { POND_ACTING_TG_ID: from_user_id }`
  injects the waking Telegram update's authenticated `from.id` into the MCP's env per cycle, below
  cognition. Every leader call carries it as `X-Acting-Tg-Id`; the leader's id-gate makes strangers
  see nothing (404 ⇒ "you have no such agent", never an existence oracle). This is why the server is
  **stdio, not http**: the engine applies `scope_env` to stdio transports only.
- **Plane-C values never enter cognition.** Configurator URLs and pond-generated one-time
  credentials are minted into `H-…` handles (`pond_handles` table: owner-bound to the minting
  cycle's acting id, single-use, TTL 30 min). The model forwards the token in its reply text;
  `telegram-mcp.ts` splices the real value at delivery ONLY when the reply chat equals the stored
  owner (in a DM, chat_id == user_id — so a group or another user's chat structurally refuses).
  All-or-nothing per message; a failed Telegram send restores the handles; the tool result carries
  a count, never the value. A leaked/recalled handle is a dead recipient-bound pointer.
- **The manager JWT** (`leader token --scope duck:manager --sub dack-manager --ttl 30d`) rides a
  secrets provider (`secrets/pond_manager.token`, file-based like the other channel tokens) into the
  MCP + module env only — never model context. The pond-manager duck deployment is capability-poor
  by design (no workers, no self-plugged tools beyond the vetted set), so even a fully injected duck
  has no exfiltration path for it.
- **Not in the surface, by design**: logs, restore, migrate, delete, exec, re-bind,
  choose-recipient, read-secret-value. Do not add tools for them (PRD §12).

## Ingress: lossy fast path, durable journal

The leader journals every event before pushing it on `ws /v1/ws/manager`; frames carry the journal
`id`. `pond-ingress.ts` persists the highest id it has delivered (`pond_cursor`) and on every
(re)connect replays `GET /v1/manager/events?after=<cursor>` before consuming live frames — no gap,
no double-wake (the cursor advances only on a harness 202; per-user `dedup_key` coalescing absorbs
the rare overlap). The leader never pings and ignores inbound frames, so the module sends a
keepalive text frame every 30 s and reconnects on failure (jittered 1 s → 30 s backoff, forever).
Unknown event types advance the cursor silently — the leader will grow types before the duck learns
them.

## Wiring (all in `dack.config.example.yaml`, commented)

`mcp_servers` (pond-management, tier `post`, trust `self`), `secrets_providers` (pond_manager),
`modules:` (pond-ingress), `webhooks:` (`"/pond/events": public` — platform-authored, but Express
is all a notification needs). Grant the server in **DM-woken states only** (PRD §6.5): the states a
public-reply or twitter stimulus enters must never import `pond-management`.

The duty (soul-side), e.g. `stimuli/pond-events/STIMULUS.md`:

```markdown
---
id: pond-events
trigger: { type: webhook, path: /pond/events }
directive_tier: self
emits: { type: pond_event }
coalesce: { mode: batch, window_secs: 60 }
entry: pond/perceive
priority: high
---
A pond platform event about one user's hosted agent (billing today: credits_low /
credits_exhausted). Wake, understand the event, and tell the affected user in their DM —
the reply path is already locked to them. Numbers come from the platform; relay them
faithfully and say how to top up.
```

The ingress POSTs top-level scalars the engine's locks key on: `chat_id` = `from_user_id` =
`tg_user_id` (destination lock), `dedup_key` = the user id (thread serialization), plus
`type/agent/balance/credits_per_day/text`.

## Local dev loop

Leader + pond running per the handoff §6 (`dack-leader`: `make db` + `leader serve`; `dack-pond`:
`pond serve`, dev tenant tg `424242`, template `whoami` priced 10):

```sh
cd ../dack-leader && ./target/debug/leader token --scope duck:manager --sub dack-manager --ttl 30d \
  > ../dack-engine/secrets/pond_manager.token
cd ../dack-engine/mcp && bun test pond          # store + client units
# credits: docker exec leader-pg psql -U leader leader -c \
#   "update tenants set credits = credits + 100 where tg_user_id='424242'"
# force a billing event: backdate agents.last_charged_at 25h, tick ≤1h (or fleet.billing_tick_secs: 30)
```

## Status / next

- Built + unit-tested + live-smoked vs the local leader (2026-08-19, branch `feat/pond-manager`):
  client parity on credits/templates/agents/stranger-404/events; WS connect + replay + hold.
- NEXT: driver-level E2E (create → configurator handle → splice), then a real DM E2E through a
  running duck with a test bot; then the pond-manager duck's own soul (CEO persona, DM states,
  capability-poor config) as its own artifact.
- Asks for the leader session: none blocking. Future event types (agent-down, backup-failed,
  setup-complete) slot into `translate()` in `pond-ingress.ts` one case each.
