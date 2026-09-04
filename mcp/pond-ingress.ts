/**
 * Pond INGRESS — a `modules:`-supervised WS client on the leader's stimulus socket
 * (`/v1/ws/manager`). Leader events (credits today; the type set will grow) become duck stimuli:
 * a POST to the harness webhook that wakes the duck to TELL THE AFFECTED USER, destination-locked
 * to that user's DM by the payload scalars (`chat_id` = `from_user_id` = the event's `tg_user_id`;
 * in a Telegram DM chat_id == user_id).
 *
 * Delivery discipline (handoff §3): the WS is a lossy fast path over a durable journal. Every frame
 * carries the journal `id`; we persist the highest id PROCESSED (pond_cursor in the shared ingress
 * SQLite) and on every (re)connect first replay `GET /v1/manager/events?after=<cursor>`, then consume
 * live frames, deduping by id. The cursor advances only after the harness ACKs the webhook (202) —
 * at-least-once into the bus, where per-user coalescing absorbs the rare duplicate.
 *
 * The leader never pings and ignores every inbound frame — so we SEND a periodic text frame as
 * keepalive (NAT liveness + dead-socket detection); a send failure forces a reconnect. Reconnect is
 * jittered exponential backoff 1 s → 30 s, forever; unknown event types advance the cursor silently.
 *
 * Env: MANAGER_JWT (module secrets), POND_LEADER_URL (default http://127.0.0.1:7700 — the WS URL is
 * derived), HARNESS_WEBHOOK (default http://127.0.0.1:8787), POND_EVENTS_PATH (default /pond/events),
 * INGRESS_DB (cursor store, same file the harness injects into the MCPs).
 */
import { openIngressStore, markReferralApplied, pendingReferrals } from './ingress-store'
import { leaderClient, normalizeEvent, TERMINAL_REDEEM_REASONS, type EventRow } from './pond-leader'
import { getCursor, openPondStore, setCursor } from './pond-store'

const LEADER_URL = (process.env.POND_LEADER_URL ?? 'http://127.0.0.1:7700').replace(/\/+$/, '')
const WS_URL = LEADER_URL.replace(/^http/, 'ws') + '/v1/ws/manager'
const WEBHOOK = (process.env.HARNESS_WEBHOOK ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const EVENTS_PATH = process.env.POND_EVENTS_PATH ?? '/pond/events'
const JWT = process.env.MANAGER_JWT
const DB_PATH = process.env.INGRESS_DB

if (!JWT) {
  console.error('[pond-ingress] MANAGER_JWT not set — exiting (supervisor will restart w/ backoff)')
  process.exit(1)
}
if (!DB_PATH) {
  console.error('[pond-ingress] INGRESS_DB not set — exiting (cursor needs a home)')
  process.exit(1)
}
const db = openPondStore(DB_PATH)
const leader = leaderClient({ baseUrl: LEADER_URL, jwt: JWT })

// ── Event → stimulus translation ────────────────────────────────────────────────────────────────

/** A human line the duck can lean on + the structured facts. Events are FLAT (type-specific fields
 *  sit beside id/type/tg_user_id/agent; `normalizeEvent` in the client flattens any legacy nested
 *  payload). Unknown types → null (skip, advance — the leader grows types before the duck learns them). */
function translate(ev: EventRow): Record<string, unknown> | null {
  if (!ev.tg_user_id) return null // no addressee — nothing to wake for
  let text: string
  const extra: Record<string, unknown> = {}
  switch (ev.type) {
    case 'credits_low':
      text =
        `Pond billing: user's agent '${ev.agent}' credits are LOW — balance ${ev.balance}, daily cost ` +
        `${ev.credits_per_day}. They cannot cover another day; let them know how to top up.`
      extra.balance = ev.balance ?? null
      extra.credits_per_day = ev.credits_per_day ?? null
      break
    case 'credits_exhausted':
      text =
        `Pond billing: user's agent '${ev.agent}' credits are EXHAUSTED — balance ${ev.balance} ` +
        `(daily cost ${ev.credits_per_day}). Service is at risk; tell them how to top up.`
      extra.balance = ev.balance ?? null
      extra.credits_per_day = ev.credits_per_day ?? null
      break
    case 'agent_created':
      text =
        `Pond: user's agent '${ev.agent}' (template ${ev.template}) finished provisioning and is READY. ` +
        `Tell them, and offer the next step (usually enter_configurator to set secrets/config).`
      extra.template = ev.template ?? null
      break
    case 'agent_create_failed':
      text =
        `Pond: creating user's agent '${ev.agent}' (template ${ev.template}) FAILED: ${ev.error}. ` +
        `The day-1 charge was refunded automatically. Apologize, relay the reason, suggest retrying.`
      extra.template = ev.template ?? null
      extra.error = ev.error ?? null
      break
    case 'agent_suspended':
      text =
        `Pond billing: user's agent '${ev.agent}' was SUSPENDED (paused) — balance ${ev.balance}, next ` +
        `day needs ${ev.needed}. Nothing is lost and nothing is charged while paused; it auto-resumes ` +
        `on the tick after they top up. Tell them plainly and say how to top up.`
      extra.balance = ev.balance ?? null
      extra.needed = ev.needed ?? null
      break
    case 'agent_resumed':
      text =
        `Pond billing: user's agent '${ev.agent}' auto-RESUMED after top-up — balance ${ev.balance}, ` +
        `daily cost ${ev.credits_per_day}. Let them know it's back.`
      extra.balance = ev.balance ?? null
      extra.credits_per_day = ev.credits_per_day ?? null
      break
    case 'referral_redeemed':
      // Lands on the REFERRER's tg: someone they invited just joined.
      text =
        `Pond referral: someone joined through this user's referral link — they earned ` +
        `${ev.credits_earned} credits (balance now ${ev.balance}). Congratulate them briefly.`
      extra.credits_earned = ev.credits_earned ?? null
      extra.balance = ev.balance ?? null
      break
    default:
      return null // forward-compat: new leader event types appear before we teach the duck about them
  }
  return {
    // Top-level SCALARS are load-bearing: scope_env + skill refs resolve against them.
    type: ev.type,
    agent: ev.agent,
    ...extra,
    tg_user_id: ev.tg_user_id,
    from_user_id: ev.tg_user_id, // the attested addressee — what user-scoped locks key on
    chat_id: ev.tg_user_id, // DM chat == user id: destination-locks the reply to their DM
    dedup_key: String(ev.tg_user_id), // per-user thread: coalesces bursts, serializes wakes
    event_id: ev.id,
    text,
  }
}

/** POST one wake body into the duck's bus. True ⇒ the harness accepted it (202). */
async function postWake(body: Record<string, unknown>, label: string): Promise<boolean> {
  try {
    const r = await fetch(`${WEBHOOK}${EVENTS_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (r.status === 202) return true
    console.error(`[pond-ingress] harness webhook ${EVENTS_PATH} → ${r.status} (${label})`)
    return false
  } catch (e: any) {
    console.error(`[pond-ingress] harness webhook unreachable (${label}): ${e?.message ?? e}`)
    return false
  }
}

/** Deliver one event into the duck's bus. True ⇒ the harness accepted it (202) or it needs no wake. */
async function deliver(ev: EventRow): Promise<boolean> {
  const body = translate(ev)
  if (!body) {
    if (!ev.tg_user_id) console.error(`[pond-ingress] event ${ev.id} (${ev.type}) has no tg_user_id — skipped`)
    return true
  }
  return postWake(body, `event ${ev.id}`)
}

/** Process in id order; stop (and DON'T advance) on the first delivery failure — replay resumes there. */
async function process_(events: EventRow[]): Promise<void> {
  for (const ev of events.sort((a, b) => a.id - b.id)) {
    if (ev.id <= getCursor(db)) continue // replay/live overlap — already handled
    if (!(await deliver(ev))) return
    setCursor(db, ev.id)
  }
}

/** Catch up from the durable journal — everything after our cursor, paged. */
async function replay(): Promise<void> {
  for (;;) {
    const page = await leader.events(getCursor(db), 500)
    if (page.length === 0) return
    const before = getCursor(db)
    await process_(page)
    if (getCursor(db) === before) return // delivery stalled — don't spin; next (re)connect resumes
    if (page.length < 500) return
  }
}

// ── Referral auto-redeem (Phase 4, handoff 2026-08-27) — BELOW COGNITION ─────────────────────────
// The telegram ingress captures `?start=<code>` deep-link opens first-touch into the shared ingress
// store. This loop drains the pending rows: redeem against the leader with THAT user's identity (the
// code comes from the captured param, never model text), mark applied on any decided outcome
// (thrown = transient → stays pending, retried next tick; both sides are idempotent), and on a grant
// wake the duck to welcome the new user with their bonus. The model never sees a code it didn't earn.

const ingressDb = openIngressStore(DB_PATH) // same file as the pond store; creates the referrals table
const REDEEM_TICK_MS = 20_000

async function redeemTick(): Promise<void> {
  for (const ref of pendingReferrals(ingressDb, 20)) {
    const user = leaderClient({ baseUrl: LEADER_URL, jwt: JWT, actingTgId: ref.user_id })
    try {
      const r = await user.redeemReferral(ref.param)
      markReferralApplied(ingressDb, ref.user_id) // decided either way — stop retrying
      if (r.redeemed) {
        console.error(`[pond-ingress] referral ${ref.param} redeemed for ${ref.user_id}: +${r.referee_bonus}`)
        await postWake(
          {
            type: 'referral_welcome',
            referee_bonus: r.referee_bonus,
            balance: r.balance,
            plan: r.plan,
            tg_user_id: ref.user_id,
            from_user_id: ref.user_id,
            chat_id: ref.chat_id, // the DM the /start arrived in
            dedup_key: String(ref.user_id),
            text:
              `Pond referral: this user's invite code was accepted — they received ${r.referee_bonus} ` +
              `credits (balance ${r.balance}). Welcome them warmly and mention the credits.`,
          },
          `referral ${ref.user_id}`,
        )
      } else {
        const tone = TERMINAL_REDEEM_REASONS.has(r.reason) ? '' : ' (unexpected reason)'
        console.error(`[pond-ingress] referral ${ref.param} for ${ref.user_id}: ${r.reason}${tone} — quiet`)
      }
    } catch (e: any) {
      // Transient (network/5xx): leave pending, the next tick retries. Redeem is idempotent.
      console.error(`[pond-ingress] referral redeem transient failure for ${ref.user_id}: ${e?.message ?? e}`)
    }
  }
}
setInterval(() => void redeemTick().catch((e) => console.error('[pond-ingress] redeem tick:', e)), REDEEM_TICK_MS)

// ── The socket loop ──────────────────────────────────────────────────────────────────────────────

const BACKOFF_FLOOR_MS = 1_000
const BACKOFF_CAP_MS = 30_000
const STABLE_MS = 60_000
const KEEPALIVE_MS = 30_000

let backoff = BACKOFF_FLOOR_MS

function connectOnce(): Promise<void> {
  return new Promise((resolve) => {
    // Bun's WebSocket accepts custom headers; the `?token=` fallback exists but keeps the JWT out of
    // logs less reliably — prefer the header.
    const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${JWT}` } } as any)
    const openedAt = Date.now()
    let keepalive: ReturnType<typeof setInterval> | null = null
    let queue: Promise<void> = Promise.resolve() // serialize frame processing (order + cursor discipline)

    const finish = () => {
      if (keepalive) clearInterval(keepalive)
      resolve()
    }

    ws.onopen = () => {
      console.error(`[pond-ingress] connected ${WS_URL}; replaying after id ${getCursor(db)}`)
      queue = queue.then(() => replay()).catch((e) => console.error('[pond-ingress] replay failed:', e?.message ?? e))
      keepalive = setInterval(() => {
        try {
          ws.send('ping') // leader ignores inbound frames; this is pure liveness
        } catch {
          ws.close()
        }
      }, KEEPALIVE_MS)
    }
    ws.onmessage = (m: MessageEvent) => {
      if (typeof m.data !== 'string') return
      let ev: EventRow
      try {
        ev = normalizeEvent(JSON.parse(m.data))
      } catch {
        return
      }
      if (typeof ev?.id !== 'number' || typeof ev?.type !== 'string') return
      queue = queue
        .then(() => process_([ev]))
        .catch((e) => console.error('[pond-ingress] frame processing failed:', e?.message ?? e))
    }
    ws.onerror = (e: any) => console.error('[pond-ingress] ws error:', e?.message ?? 'unknown')
    ws.onclose = (e: CloseEvent) => {
      console.error(`[pond-ingress] disconnected (code ${e.code})`)
      if (Date.now() - openedAt > STABLE_MS) backoff = BACKOFF_FLOOR_MS
      finish()
    }
  })
}

console.error(`[pond-ingress] starting; leader=${LEADER_URL} webhook=${WEBHOOK}${EVENTS_PATH} cursor=${getCursor(db)}`)
for (;;) {
  await connectOnce()
  const jitter = 0.8 + Math.random() * 0.4
  const wait = Math.round(backoff * jitter)
  backoff = Math.min(backoff * 2, BACKOFF_CAP_MS)
  console.error(`[pond-ingress] reconnecting in ${wait}ms`)
  await new Promise((r) => setTimeout(r, wait))
}
