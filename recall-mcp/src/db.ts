/**
 * Shared SQLite read layer for the two recall MCP servers (harness v0.2.0). Reads the harness-authored
 * `runlogs.sqlite` (path in `RUNLOG_DB`). Opened READ-WRITE + `PRAGMA query_only=ON`: a WAL database
 * needs to create its `-shm` (impossible on a pure read-only handle), but `query_only` still forbids
 * every write — so the recall servers can read a live WAL db yet can never mutate it.
 *
 * The trust boundary lives HERE, at the column level: the SELF server calls only the `thought`/`sent`
 * projections + `{thought,sent}`-scoped FTS and never reads `incoming`; the PUBLIC server may read
 * `incoming` (and taints its cycle by doing so). One store, two disciplined views.
 */
import { Database } from 'bun:sqlite'

export interface Row {
  run_id: string
  ts: number
  trust: string
  state: string
  thought: string
  sent: string[]
  incoming: { from: string; text: string }[]
  tags: string[]
}

export function openDb(path = process.env.RUNLOG_DB ?? 'runlogs.sqlite'): Database {
  const db = new Database(path) // read-write so WAL's -shm can be created...
  db.run('PRAGMA query_only=ON') // ...but every write is refused. Reads only.
  db.run('PRAGMA busy_timeout=5000')
  return db
}

// ── time / trust / truncation (same formats as the harness clock + the old recall lib) ──

export function fmtTime(sec: number): string {
  if (!sec) return ''
  return new Date(sec * 1000).toISOString().replace('T', ' ').replace(/\..+Z$/, ' UTC')
}

const TRUST_RANK: Record<string, number> = { public: 1, org: 2, self: 3 }
const trustRank = (t: string) => TRUST_RANK[t] ?? 0
export const atLeastTrust = (rows: Row[], minTrust?: string) =>
  !minTrust ? rows : rows.filter((r) => trustRank(r.trust) >= trustRank(minTrust))

export const clamp = (n: number | undefined, def: number, max: number) => Math.min(max, Math.max(1, n ?? def))

export function truncMark(s: string, n: number, runId: string): string {
  if (s.length <= n) return s
  return `${s.slice(0, n).trimEnd()}… [+${s.length - n} chars — read_entry "${runId}" for the full entry]`
}

function parseIncoming(raw: string): { from: string; text: string }[] {
  let j: any
  try {
    j = JSON.parse(raw)
  } catch {
    return []
  }
  const one = (m: any) => ({
    from: String(m?.from_username ?? m?.author ?? m?.from_user_id ?? '?'),
    text: String(m?.text ?? m?.body ?? '').replace(/\s+/g, ' ').trim(),
  })
  if (Array.isArray(j?.items) && j.items.length) return j.items.map(one)
  return [one(j)]
}

// ── keyset pagination (stable under concurrent appends — page on run_id, not offset) ──

const encodeCursor = (runId: string) => Buffer.from(JSON.stringify({ r: runId })).toString('base64')
const decodeCursor = (cursor?: string): string | null => {
  if (!cursor) return null
  try {
    const o = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'))
    return typeof o?.r === 'string' ? o.r : null
  } catch {
    return null
  }
}
export interface Page<T> {
  items: T[]
  total: number
  returned: number
  has_more: boolean
  cursor: string | null
}
/** Keyset-page a chronological (newest-last) list, NEWEST first. */
export function cursorPage(rows: Row[], limit: number, cursor?: string): Page<Row> {
  const lim = Math.max(1, limit)
  let end = rows.length
  const after = decodeCursor(cursor)
  if (after) {
    const idx = rows.findIndex((r) => r.run_id === after)
    if (idx >= 0) end = idx
  }
  const start = Math.max(0, end - lim)
  const page = rows.slice(start, end)
  const has_more = start > 0
  return {
    items: page,
    total: rows.length,
    returned: page.length,
    has_more,
    cursor: has_more && page.length ? encodeCursor(page[0].run_id) : null,
  }
}

// ── row mapping + queries ──

const SELECT = `SELECT e.run_id, e.ts, e.trust, e.state, e.thought, e.sent, e.incoming,
  (SELECT GROUP_CONCAT(tag) FROM entry_tags WHERE run_id = e.run_id) AS tags
  FROM entries e`

function mapRow(r: any): Row {
  let sent: string[] = []
  try {
    sent = JSON.parse(r.sent || '[]')
  } catch {
    /* keep [] */
  }
  return {
    run_id: r.run_id,
    ts: r.ts,
    trust: r.trust || '',
    state: r.state || '',
    thought: r.thought || '',
    sent,
    incoming: parseIncoming(r.incoming || ''),
    tags: r.tags ? String(r.tags).split(',') : [],
  }
}

/** Entries carrying `tag`, optional `[from,to]` window, chronological (oldest→newest). */
export function byTag(db: Database, tag: string, from?: number, to?: number): Row[] {
  const rows = db
    .query(
      `${SELECT} WHERE e.run_id IN (SELECT run_id FROM entry_tags WHERE tag = ?1)
       AND (?2 = 0 OR e.ts >= ?2) AND (?3 = 0 OR e.ts <= ?3) ORDER BY e.ts`,
    )
    .all(tag, from ?? 0, to ?? 0)
  return rows.map(mapRow)
}

/** Entries within `ts ± window`, optionally filtered to `tag`. */
export function around(db: Database, ts: number, window: number, tag?: string): Row[] {
  const lo = ts - window
  const hi = ts + window
  const sql = tag
    ? `${SELECT} WHERE e.ts BETWEEN ?1 AND ?2 AND e.run_id IN (SELECT run_id FROM entry_tags WHERE tag = ?3) ORDER BY e.ts`
    : `${SELECT} WHERE e.ts BETWEEN ?1 AND ?2 ORDER BY e.ts`
  const rows = tag ? db.query(sql).all(lo, hi, tag) : db.query(sql).all(lo, hi)
  return rows.map(mapRow)
}

/** The last `days` of entries that produced OWN output (thought or sent) — the self activity feed. */
export function recentActivity(db: Database, days: number): Row[] {
  const since = Math.floor(Date.now() / 1000) - days * 86400
  const rows = db
    .query(`${SELECT} WHERE e.ts >= ?1 AND (e.thought != '' OR e.sent != '[]') ORDER BY e.ts`)
    .all(since)
  return rows.map(mapRow)
}

/** The self activity feed within an explicit `[from, to]` window (either bound `0` = open). */
export function activityWindow(db: Database, from: number, to: number): Row[] {
  const rows = db
    .query(
      `${SELECT} WHERE (?1 = 0 OR e.ts >= ?1) AND (?2 = 0 OR e.ts <= ?2)
       AND (e.thought != '' OR e.sent != '[]') ORDER BY e.ts`,
    )
    .all(from, to)
  return rows.map(mapRow)
}

/** FTS5 search over `columns` (the trust boundary) → hits with a highlighted snippet, newest-first. */
export function search(
  db: Database,
  query: string,
  columns: string[],
  limit: number,
): { run_id: string; tag: string; at: string; snippet: string }[] {
  const scoped = `{${columns.join(' ')}} : (${query})`
  const col = columns.includes('incoming') && columns.length === 1 ? 2 : 0 // snippet from incoming vs thought
  const rows = db
    .query(
      `SELECT e.run_id, e.ts,
        (SELECT tag FROM entry_tags WHERE run_id = e.run_id LIMIT 1) AS tag,
        snippet(entries_fts, ${col}, '[', ']', '…', 12) AS snip
       FROM entries_fts f JOIN entries e ON e.rowid = f.rowid
       WHERE entries_fts MATCH ?1 ORDER BY rank LIMIT ?2`,
    )
    .all(scoped, limit) as any[]
  return rows.map((r) => ({ run_id: r.run_id, tag: r.tag ?? '', at: fmtTime(r.ts), snippet: (r.snip ?? '').replace(/\s+/g, ' ').trim() }))
}

export function readEntry(db: Database, runId: string): Row | null {
  const r = db.query(`${SELECT} WHERE e.run_id = ?1`).get(runId)
  return r ? mapRow(r) : null
}

/** Tag-intersection: tags that co-occur on entries also carrying `tag`, most-frequent first. */
export function relatedTags(db: Database, tag: string, limit: number): { tag: string; count: number; last_seen: string }[] {
  const rows = db
    .query(
      `SELECT b.tag AS tag, COUNT(*) n, MAX(b.ts) last_seen
       FROM entry_tags a JOIN entry_tags b ON a.run_id = b.run_id
       WHERE a.tag = ?1 AND b.tag != ?1 GROUP BY b.tag ORDER BY n DESC, last_seen DESC LIMIT ?2`,
    )
    .all(tag, limit) as any[]
  return rows.map((r) => ({ tag: r.tag, count: r.n, last_seen: fmtTime(r.last_seen) }))
}

export interface Note {
  tag: string
  kind: string
  note: string
  trust: string
  at: string
  delivered: boolean
}
/** Typed tag-notes (`memory` | `digest`), newest-first. `includeExpired` shows delivered digest notes;
 * by default they're hidden. `soft_days` hides `memory` notes older than that (the surfaced window). */
export function tagNotes(
  db: Database,
  opts: { kind?: string; tag?: string; includeExpired?: boolean; minTrust?: string; softDays?: number } = {},
): Note[] {
  const conds: string[] = []
  const binds: any[] = []
  if (opts.kind) {
    binds.push(opts.kind)
    conds.push(`n.kind = ?${binds.length}`)
  }
  if (opts.tag) {
    binds.push(opts.tag)
    conds.push(`nt.tag = ?${binds.length}`)
  }
  if (!opts.includeExpired) conds.push(`n.delivered_at IS NULL`)
  if (opts.softDays) {
    binds.push(Math.floor(Date.now() / 1000) - opts.softDays * 86400)
    conds.push(`(n.kind != 'memory' OR n.ts >= ?${binds.length})`)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const rows = db
    .query(
      `SELECT nt.tag, n.kind, n.note, n.trust, n.ts, n.delivered_at
       FROM tag_notes n JOIN note_tags nt ON nt.note_id = n.id ${where} ORDER BY n.ts DESC`,
    )
    .all(...binds) as any[]
  let out = rows.map((r) => ({
    tag: r.tag,
    kind: r.kind,
    note: r.note,
    trust: r.trust || '',
    at: fmtTime(r.ts),
    delivered: r.delivered_at != null,
  }))
  if (opts.minTrust) {
    const floor = trustRank(opts.minTrust)
    out = out.filter((n) => trustRank(n.trust) >= floor)
  }
  return out
}

// ── model-facing renderers (same shape as the old recall lib, from rows) ──

/** Both sides of a conversation (incoming + your replies) — the PUBLIC view (taints). */
export function renderTranscript(rows: Row[], maxMsg = 500): string {
  if (!rows.length) return '(no recalled messages)'
  const lines: string[] = []
  const push = (l: string) => {
    if (lines[lines.length - 1] !== l) lines.push(l)
  }
  for (const e of rows) {
    for (const inc of e.incoming) if (inc.text) push(`[@${inc.from}]: ${truncMark(inc.text, maxMsg, e.run_id)}`)
    for (const s of e.sent) push(`  ↳ you: ${truncMark(s, maxMsg, e.run_id)}`)
  }
  return lines.join('\n')
}

/** Your OWN reasoning + replies (NEVER incoming) — the SELF view (firebreak-clean). */
export function renderThoughtLog(rows: Row[], maxThought = 400, maxSent = 200): string {
  if (!rows.length) return '(no recalled activity)'
  const lines: string[] = []
  for (const e of rows) {
    const tag = e.tags[0] ?? '?'
    if (e.thought) lines.push(`[${e.run_id} · ${tag} · ${e.trust || '?'} · ${fmtTime(e.ts)}] thought: ${truncMark(e.thought, maxThought, e.run_id)}`)
    for (const s of e.sent) lines.push(`  ↳ you: ${truncMark(s, maxSent, e.run_id)}`)
  }
  return lines.join('\n')
}

/** ONE entry in full. `includeIncoming` adds raw incoming — PUBLIC server only (taints). */
export function renderEntryFull(e: Row, includeIncoming = false): string {
  const tag = e.tags[0] ?? '?'
  const lines = [`[${e.run_id} · ${tag} · ${e.trust || '?'} · ${e.state} · ${fmtTime(e.ts)}]`]
  if (includeIncoming) for (const inc of e.incoming) if (inc.text) lines.push(`[@${inc.from}]: ${inc.text}`)
  if (e.thought) lines.push(`thought: ${e.thought}`)
  for (const s of e.sent) lines.push(`  ↳ you: ${s}`)
  return lines.join('\n')
}
