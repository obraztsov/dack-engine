/**
 * Pond store — the dack-manager's durable state, living in the SAME SQLite file as the ingress store
 * (the harness injects `INGRESS_DB` absolute into every stdio MCP; the pond ingress module gets the
 * same path via its static env). Two concerns:
 *
 *   - **Secret handles (the envelope, PRD §6.6 / handoff §4).** Plane-C values the duck must ROUTE but
 *     never READ (configurator URLs, pond-generated one-time credentials) are stored here keyed by a
 *     short opaque handle, bound to the ACTING USER who minted them (harness-injected id, never a model
 *     argument). The telegram egress resolves a handle only when the delivery destination equals the
 *     stored owner — both sides of that equality are harness-side facts, so a leaked/replayed handle is
 *     worthless: wrong chat → refused; expired/consumed → refused. Values never appear in tool results,
 *     the runlog, or model context.
 *
 *   - **The ingress cursor.** The leader journals every stimulus event before pushing it on the WS
 *     (frame `id` = journal id); the ingress persists the highest id it has processed so every
 *     (re)connect replays `GET /events?after=<cursor>` before consuming live frames — no gap, no
 *     double-wake (webhook POST happens before the cursor advances; coalescing absorbs the rare replay).
 *
 * WAL mode so the minting MCP, the splicing telegram MCP, and the ingress module share it safely.
 */
import { Database } from 'bun:sqlite'

/** Handle token shape: short + distinctive so the model forwards it reliably and the splice can find it
 *  in prose. The entropy is NOT the security (the owner-binding is); 12 base36 chars just make guessing
 *  pointless within the TTL. */
const HANDLE_RE = /\bH-[a-z0-9]{12}\b/g

export function openPondStore(path: string): Database {
  const db = new Database(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec(
    'CREATE TABLE IF NOT EXISTS pond_handles ' +
      '(handle TEXT PRIMARY KEY, value TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL, ' +
      'created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER)',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS pond_cursor ' +
      '(id INTEGER PRIMARY KEY CHECK (id = 1), last_event_id INTEGER NOT NULL)',
  )
  return db
}

// ── Handles ──────────────────────────────────────────────────────────────────────────────────────

export type HandleKind = 'configurator_url' | 'secret'

const now = () => Math.floor(Date.now() / 1000)

function randomHandle(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += (b % 36).toString(36)
  return `H-${s}`
}

/** Mint a handle for `value`, bound to `owner` (the ACTING user's tg id — harness-injected, never a
 *  model argument). Single-use, expiring. Opportunistically sweeps long-dead rows. */
export function mintHandle(
  db: Database,
  value: string,
  owner: string,
  kind: HandleKind,
  ttlSecs = 1800,
  at: number = now(),
): string {
  db.query('DELETE FROM pond_handles WHERE expires_at < ?').run(at - 86400)
  const handle = randomHandle()
  db.query(
    'INSERT INTO pond_handles (handle, value, owner, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(handle, value, owner, kind, at, at + Math.max(1, ttlSecs))
  return handle
}

export type SpliceResult =
  | { ok: true; text: string; spliced: number; handles: string[] }
  | { ok: false; handle: string; reason: 'unknown' | 'expired' | 'consumed' | 'wrong_destination' }

/** Why a handle did not resolve — for the refusal message/log only; NEVER returns the value. */
function diagnose(db: Database, handle: string, destination: string, at: number): SpliceResult {
  const row = db.query('SELECT owner, expires_at, consumed_at FROM pond_handles WHERE handle = ?').get(handle) as
    | { owner: string; expires_at: number; consumed_at: number | null }
    | null
  if (!row) return { ok: false, handle, reason: 'unknown' }
  if (row.consumed_at != null) return { ok: false, handle, reason: 'consumed' }
  if (row.expires_at <= at) return { ok: false, handle, reason: 'expired' }
  if (row.owner !== destination) return { ok: false, handle, reason: 'wrong_destination' }
  return { ok: false, handle, reason: 'unknown' } // unreachable; satisfies the type
}

/**
 * Resolve every handle token in `text` and splice in the stored values — ALL-OR-NOTHING, atomic.
 * `destination` is the delivery chat (harness-injected `TELEGRAM_REPLY_CHAT`); a handle resolves only
 * when the stored owner equals it (in a Telegram DM chat_id == user_id, so this structurally refuses
 * groups and every other user's chat). Consumes the handles it splices. A text with no handle tokens
 * passes through untouched (`spliced: 0`).
 */
export function spliceHandles(db: Database, text: string, destination: string, at: number = now()): SpliceResult {
  const handles = [...new Set(text.match(HANDLE_RE) ?? [])]
  if (handles.length === 0) return { ok: true, text, spliced: 0, handles: [] }
  const consume = db.query(
    'UPDATE pond_handles SET consumed_at = ?1 ' +
      'WHERE handle = ?2 AND owner = ?3 AND consumed_at IS NULL AND expires_at > ?1 RETURNING value',
  )
  const run = db.transaction((): SpliceResult => {
    let out = text
    for (const h of handles) {
      const row = consume.get(at, h, destination) as { value: string } | null
      if (!row) {
        const why = diagnose(db, h, destination, at)
        throw Object.assign(new Error('splice refused'), { result: why })
      }
      out = out.replaceAll(h, row.value)
    }
    return { ok: true, text: out, spliced: handles.length, handles }
  })
  try {
    return run()
  } catch (e: any) {
    if (e?.result) return e.result as SpliceResult // transaction rolled back — nothing consumed
    throw e
  }
}

/** Un-consume handles after a DELIVERY failure (the send itself errored, so the value never reached
 *  anyone) — the user shouldn't need a fresh mint because of a network blip. Only flips rows this
 *  splice consumed (`consumed_at` matches). */
export function restoreHandles(db: Database, handles: string[], at: number): void {
  const q = db.query('UPDATE pond_handles SET consumed_at = NULL WHERE handle = ? AND consumed_at = ?')
  for (const h of handles) q.run(h, at)
}

// ── Ingress cursor ───────────────────────────────────────────────────────────────────────────────

export function getCursor(db: Database): number {
  const row = db.query('SELECT last_event_id FROM pond_cursor WHERE id = 1').get() as
    | { last_event_id: number }
    | null
  return row ? row.last_event_id : 0
}

export function setCursor(db: Database, lastEventId: number): void {
  db.query(
    'INSERT INTO pond_cursor (id, last_event_id) VALUES (1, ?1) ' +
      'ON CONFLICT(id) DO UPDATE SET last_event_id = max(last_event_id, ?1)',
  ).run(lastEventId)
}
