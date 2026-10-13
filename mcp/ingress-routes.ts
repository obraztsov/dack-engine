/**
 * ingress-routes — the shared store through which a duck "arms" a thread.
 *
 * The pond-manager pattern, reused: the duck does NOT edit ingress config. It writes a row here via a
 * self-trust MCP (`ingress-arm-mcp.ts`, Express), and the ingress consults the same SQLite file on its
 * poll. What a row says is deliberately tiny: "replies in THIS thread are a follow-up on THIS work —
 * open them with stance X and tag them Y." It never names a route: the webhook path, and so the trust
 * tier, stay exactly as the operator configured. The harness resolves `entry_hint` against the duty's
 * own `entries:` allowlist and falls back on anything unknown, so the blast radius of an arm row is
 * "wrong tone at the same trust", nothing more.
 *
 * Rows expire (TTL) — a stale arm is how a routing bug becomes a mystery. Lookup purges lazily.
 *
 * The same file carries the CHANNEL INDEX (`channels`): the ingress upserts every channel the relay lists
 * (id, name, the trust its config assigns) on each discovery, and the Buzz MCPs resolve `--channel <name>`
 * against it — so the duck addresses rooms by NAME. The relay stays the authority on names; this is a
 * cache, refreshed every discover interval. Why: 2026-10-12 a duck forwarded an org brief "to research"
 * with the one UUID it had seen recently — marketing's. A UUID is not a thing a mind remembers; a name is.
 */
import { Database } from 'bun:sqlite'

export type Arm = { thread_root: string; channel: string; entry_hint: string; tags: string[]; armed_by: string; armed_at: number; expires_at: number }

export function openRoutesStore(path: string): Database {
  const db = new Database(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  // Two processes write this file (the ingress module + an MCP tool). bun's default busy timeout is
  // 0, so a millisecond of overlap would throw "database is locked" instead of waiting.
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(`CREATE TABLE IF NOT EXISTS armed_threads (
    thread_root TEXT PRIMARY KEY,
    channel     TEXT NOT NULL,
    entry_hint  TEXT NOT NULL,
    tags        TEXT NOT NULL,
    armed_by    TEXT NOT NULL,
    armed_at    INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS channels (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    trust      TEXT NOT NULL,
    configured INTEGER NOT NULL DEFAULT 0,
    seen_at    INTEGER NOT NULL
  )`)
  // Emoji REACTIONS (kind:7) seen on the relay — the ingress polls them per channel, the react MCP records its
  // own. Keyed by the reaction event id; `target_id` is the message reacted to. Read back onto the wake spine
  // and into `own_replies`, so a 👀 from Jarvis on a task post reads as the acknowledgement it is.
  db.exec(`CREATE TABLE IF NOT EXISTS reactions (
    event_id   TEXT PRIMARY KEY,
    target_id  TEXT NOT NULL,
    channel    TEXT NOT NULL,
    pubkey     TEXT NOT NULL,
    emoji      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    seen_at    INTEGER NOT NULL
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS reactions_target ON reactions (target_id)')
  return db
}

// ── reactions ──────────────────────────────────────────────────────────────────────────────────────

export type ReactionRow = { event_id: string; target_id: string; channel: string; pubkey: string; emoji: string; created_at: number }
/** One message's reactions, folded per emoji: who (pubkeys) reacted with what, oldest emoji first. */
export type ReactionSummary = { emoji: string; count: number; by: string[] }

/** Record reactions (idempotent on the reaction event id). A kind:7 whose target is unknown is kept too —
 *  the message it points at may be older than the poll window, and `own_replies` reads by target. */
export function upsertReactions(db: Database, rows: ReactionRow[], now = Math.floor(Date.now() / 1000)): number {
  if (!rows.length) return 0
  let n = 0
  const tx = db.transaction((rs: ReactionRow[]) => {
    const q = db.query(
      `INSERT INTO reactions (event_id, target_id, channel, pubkey, emoji, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    )
    for (const r of rs) {
      if (!r.event_id || !r.target_id || !r.emoji) continue
      n += q.run(r.event_id, r.target_id, r.channel, r.pubkey, r.emoji.slice(0, 32), r.created_at, now).changes
    }
  })
  tx(rows)
  return n
}

/** Forget a reaction by (target, pubkey, emoji) — used when the duck removes its own. */
export function deleteReaction(db: Database, targetId: string, pubkey: string, emoji: string): number {
  return db.run('DELETE FROM reactions WHERE target_id = ? AND pubkey = ? AND emoji = ?', [targetId, pubkey, emoji]).changes
}

export function reactionsFor(db: Database, targetId: string): ReactionRow[] {
  return db.query('SELECT event_id, target_id, channel, pubkey, emoji, created_at FROM reactions WHERE target_id = ? ORDER BY created_at').all(targetId) as ReactionRow[]
}

/** Pure: fold rows into `[{emoji, count, by}]`; `label` renders a pubkey (a name, "you", a prefix). */
export function summarizeReactions(rows: ReactionRow[], label: (pubkey: string) => string = (p) => p.slice(0, 8)): ReactionSummary[] {
  const order: string[] = []
  const by = new Map<string, Set<string>>()
  for (const r of [...rows].sort((a, b) => a.created_at - b.created_at)) {
    if (!by.has(r.emoji)) {
      by.set(r.emoji, new Set())
      order.push(r.emoji)
    }
    by.get(r.emoji)!.add(r.pubkey)
  }
  return order.map((emoji) => {
    const who = [...by.get(emoji)!]
    return { emoji, count: who.length, by: who.map(label) }
  })
}

// ── channel index ──────────────────────────────────────────────────────────────────────────────────

export type ChannelRow = { id: string; name: string; trust: string; configured: boolean; seen_at: number }
export type ChannelRef =
  | { ok: true; id: string; name: string | null; trust: string | null; configured: boolean }
  | { ok: false; error: string; known: string[] }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A relay channel id (uuid) or another opaque id (a DM channel, 64-hex) — passed through, never "resolved". */
export const looksLikeChannelId = (v: string): boolean => UUID_RE.test(v) || /^[0-9a-f]{16,}$/i.test(v)

/** Replace the index with what the relay lists now (a channel that vanished from the relay vanishes here). */
export function upsertChannels(db: Database, rows: { id: string; name: string; trust: string; configured: boolean }[], now = Math.floor(Date.now() / 1000)): void {
  const tx = db.transaction((rs: typeof rows) => {
    db.run('DELETE FROM channels')
    const q = db.query('INSERT INTO channels (id, name, trust, configured, seen_at) VALUES (?, ?, ?, ?, ?)')
    for (const r of rs) q.run(r.id, r.name, r.trust, r.configured ? 1 : 0, now)
  })
  tx(rows)
}

export function listChannels(db: Database): ChannelRow[] {
  return (db.query('SELECT * FROM channels ORDER BY configured DESC, name').all() as any[]).map((r) => ({ ...r, configured: !!r.configured }))
}

/**
 * Resolve what the model wrote for a channel: an id passes through (annotated with its name when indexed);
 * anything else must match exactly ONE indexed name (case-insensitive, surrounding `#` tolerated). Unknown
 * or ambiguous ⇒ refused with the directory — a name that matches nothing is a typo or a hallucination,
 * never a judgment call, and the relay would reject it anyway (as a 400 the model cannot read).
 */
export function resolveChannel(db: Database, ref: string): ChannelRef {
  const rows = listChannels(db)
  if (looksLikeChannelId(ref)) {
    const r = rows.find((c) => c.id.toLowerCase() === ref.toLowerCase())
    return { ok: true, id: ref, name: r?.name ?? null, trust: r?.trust ?? null, configured: !!r?.configured }
  }
  const want = ref.trim().replace(/^#/, '').toLowerCase()
  const hits = rows.filter((c) => c.name.toLowerCase() === want)
  const known = rows.map((c) => c.name)
  if (hits.length === 1) return { ok: true, id: hits[0].id, name: hits[0].name, trust: hits[0].trust, configured: hits[0].configured }
  if (hits.length > 1) return { ok: false, error: `channel name "${ref}" is ambiguous (${hits.length} channels share it) — use the id`, known }
  return { ok: false, error: `no channel named "${ref}" — known channels: ${known.join(', ') || '(index empty — the ingress has not discovered yet)'}`, known }
}

/** One line for a tool description: the rooms this duck can name, configured (org) ones first. */
export function channelDirectoryLine(db: Database): string {
  const rows = listChannels(db)
  if (!rows.length) return ''
  return rows.map((c) => `${c.name} (${c.trust}${c.configured ? '' : ', unconfigured'})`).join(' · ')
}

const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9\-_:./]{0,79}$/
/** Index keys only: a bounded, sanitized set (a hostile caller must not spray the tag space). */
export function sanitizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const out: string[] = []
  for (const t of tags) {
    if (typeof t !== 'string') continue
    const s = t.trim()
    if (TAG_RE.test(s) && !out.includes(s)) out.push(s)
    if (out.length >= 8) break
  }
  return out
}

export function armThread(db: Database, a: Omit<Arm, 'armed_at' | 'expires_at'> & { ttl_secs: number }, now = Math.floor(Date.now() / 1000)): Arm {
  const row: Arm = { ...a, tags: sanitizeTags(a.tags), armed_at: now, expires_at: now + Math.max(60, a.ttl_secs) }
  db.run(
    `INSERT INTO armed_threads (thread_root, channel, entry_hint, tags, armed_by, armed_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(thread_root) DO UPDATE SET channel=excluded.channel, entry_hint=excluded.entry_hint,
       tags=excluded.tags, armed_by=excluded.armed_by, armed_at=excluded.armed_at, expires_at=excluded.expires_at`,
    [row.thread_root, row.channel, row.entry_hint, JSON.stringify(row.tags), row.armed_by, row.armed_at, row.expires_at],
  )
  return row
}

/** The arm for a thread root, or null. Expired rows are purged on the way. */
export function lookupArm(db: Database, threadRoot: string, now = Math.floor(Date.now() / 1000)): Arm | null {
  db.run('DELETE FROM armed_threads WHERE expires_at <= ?', [now])
  const r = db.query('SELECT * FROM armed_threads WHERE thread_root = ?').get(threadRoot) as any
  if (!r) return null
  return { ...r, tags: JSON.parse(r.tags) }
}

export function listArms(db: Database, now = Math.floor(Date.now() / 1000)): Arm[] {
  db.run('DELETE FROM armed_threads WHERE expires_at <= ?', [now])
  return (db.query('SELECT * FROM armed_threads ORDER BY armed_at DESC').all() as any[]).map((r) => ({ ...r, tags: JSON.parse(r.tags) }))
}
