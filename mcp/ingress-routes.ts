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
 */
import { Database } from 'bun:sqlite'

export type Arm = { thread_root: string; channel: string; entry_hint: string; tags: string[]; armed_by: string; armed_at: number; expires_at: number }

export function openRoutesStore(path: string): Database {
  const db = new Database(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE IF NOT EXISTS armed_threads (
    thread_root TEXT PRIMARY KEY,
    channel     TEXT NOT NULL,
    entry_hint  TEXT NOT NULL,
    tags        TEXT NOT NULL,
    armed_by    TEXT NOT NULL,
    armed_at    INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  )`)
  return db
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
