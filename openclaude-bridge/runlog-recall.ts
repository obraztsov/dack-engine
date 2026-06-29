/**
 * Pure parse/filter/render core for the runlog-recall MCP (`runlog-recall-mcp.ts`). Kept side-effect
 * free (no server, no fs reads beyond the explicit `readRecentRunlogs`) so it is unit-testable.
 *
 * It reads the duck's OWN harness-authored runlog markdown (`runlogs/*.md`) and reconstructs a compact
 * conversation transcript filtered by a TAG — both the incoming side (from the `raw stimulus` fence) and
 * what the duck SENT (reply/post tool calls). The render format is what `src/runlog/mod.rs::render`
 * emits; if that changes, update both together.
 */
import { readdirSync, readFileSync } from 'node:fs'

/** One parsed runlog entry (harness-authored; both sides of an exchange live here). */
export interface Entry {
  /** The `YYYY-MM-DD` runlog day-file this entry came from (set by `parseDay`; '' for raw concat). */
  date: string
  runId: string
  state: string
  timestamp: number
  tags: string[]
  /** Origin TRUST of this cycle (the heading's `payload_tier` — the trust of the data it digested):
   * `self` | `org` | `public` | '' . Lets the self-trust recall weight/filter by who it came from. */
  trust: string
  /** The duck's internal reasoning this cycle (logged, never sent) — used for `search_runlog`. */
  thought: string
  /** Incoming side (untrusted world): the message(s) that woke this cycle. */
  incoming: { from: string; text: string }[]
  /** What the duck SENT this cycle (reply/post text), in order. Empty = silence. */
  sent: string[]
}

/** Read the most recent `dayFiles` runlog markdown files under `dir`, oldest→newest, concatenated. */
export function readRecentRunlogs(dir: string, dayFiles = 3): string {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
  } catch {
    return '' // no runlog dir yet
  }
  return files
    .slice(-dayFiles)
    .map((f) => {
      try {
        return readFileSync(`${dir}/${f}`, 'utf8')
      } catch {
        return ''
      }
    })
    .join('\n')
}

/** Pull `text` out of a tool-call input string (JSON, possibly newline-flattened/truncated). */
export function replyText(input: string): string | null {
  try {
    const t = JSON.parse(input)?.text
    if (typeof t === 'string') return t
  } catch {
    /* fall through to a lenient regex */
  }
  const m = input.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  return m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ') : null
}

/** Parse the `raw stimulus` JSON into the incoming message(s). Telegram-shaped; degrades gracefully. */
export function parseIncoming(raw: string): { from: string; text: string }[] {
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

/** Split the concatenated runlog into entries and parse each (skipping anything malformed). `date`
 * tags each entry with the day-file it came from (set by `parseDay`; '' for a raw concat). */
export function parseEntries(text: string, date = ''): Entry[] {
  const blocks = text.split(/\n(?=## )/).filter((b) => b.startsWith('## '))
  const out: Entry[] = []
  for (const b of blocks) {
    const head = b.match(/^## (\S+) · (\w+)/)
    if (!head) continue
    const ts = b.match(/^- timestamp: (\d+)/m)
    const tagsLine = b.match(/^- tags: (.+)$/m)
    const tags = tagsLine ? tagsLine[1].split(',').map((t) => t.trim()).filter(Boolean) : []
    // Origin trust = the heading's `payload_tier` (the trust of the data this cycle digested).
    const trustM = b.match(/payload_tier=TrustTier\("(\w+)"\)/)
    const thoughtLine = b.match(/^- thought: (.+)$/m)
    const rawFence = b.match(/```untrusted\n([\s\S]*?)\n```/)
    const incoming = rawFence ? parseIncoming(rawFence[1]) : []
    const sent: string[] = []
    const callRe = /^\s*- `mcp__\w+__(?:reply|post|send_message)` (.+?) → /gm
    let m: RegExpExecArray | null
    while ((m = callRe.exec(b)) !== null) {
      const t = replyText(m[1])
      if (t) sent.push(t)
    }
    out.push({
      date,
      runId: head[1],
      state: head[2],
      timestamp: ts ? parseInt(ts[1], 10) : 0,
      tags,
      trust: trustM ? trustM[1] : '',
      thought: thoughtLine ? thoughtLine[1].trim() : '',
      incoming,
      sent,
    })
  }
  return out
}

/** Render a compact, clearly-labelled transcript (PAST DATA — never instructions) for the model.
 * Consecutive identical lines are collapsed: one wake's batch appears in BOTH its perceive entry and
 * each express fan-out entry (same `raw_stimulus`), so the incoming text would otherwise repeat. */
export function renderTranscript(entries: Entry[]): string {
  if (!entries.length) return '(no recalled messages for this tag)'
  const lines: string[] = []
  const push = (l: string) => {
    if (lines[lines.length - 1] !== l) lines.push(l)
  }
  for (const e of entries) {
    for (const inc of e.incoming) {
      if (inc.text) push(`[@${inc.from}]: ${inc.text}`)
    }
    for (const s of e.sent) push(`  ↳ you: ${s}`)
  }
  return lines.join('\n')
}

/** Filter to a tag, then page from the MOST RECENT end: offset skips the newest, limit caps. */
export function pageByTag(entries: Entry[], tag: string, limit: number, offset: number): Entry[] {
  const matched = entries.filter((e) => e.tags.includes(tag))
  const end = matched.length - offset
  const start = Math.max(0, end - limit)
  return end > 0 ? matched.slice(start, end) : []
}

/** Distinct tags newest-first, each with who's been seen under it — to find a tag for `recall_by_tag`. */
export function listRecentTags(entries: Entry[], limit: number): { tag: string; last_seen: number; users: string[] }[] {
  const byTag = new Map<string, { lastSeen: number; users: Set<string> }>()
  for (const e of entries) {
    for (const tag of e.tags) {
      const cur = byTag.get(tag) ?? { lastSeen: 0, users: new Set<string>() }
      cur.lastSeen = Math.max(cur.lastSeen, e.timestamp)
      for (const inc of e.incoming) if (inc.from && inc.from !== '?') cur.users.add(inc.from)
      byTag.set(tag, cur)
    }
  }
  return [...byTag.entries()]
    .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
    .slice(0, limit)
    .map(([tag, v]) => ({ tag, last_seen: v.lastSeen, users: [...v.users].slice(0, 6) }))
}

export const clamp = (n: number | undefined, def: number, max: number) => Math.min(max, Math.max(1, n ?? def))

// ---------------------------------------------------------------------------------------------------
// Navigation/discovery — so the model can map the runlog (a 2-D space of date × conversation) WITHOUT
// ever touching the file tools (the `runlogs/` dir is gitignored → Glob misses files, and a dense day
// blows the read size-limit). Each function below is a thin, cheap read over the same day-files.
// ---------------------------------------------------------------------------------------------------

const DATE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/

/** Ascending date strings (`YYYY-MM-DD`) of the most recent `n` runlog days — cheap (names only). */
export function recentDates(dir: string, n: number): string[] {
  try {
    return readdirSync(dir)
      .map((f) => f.match(DATE_RE)?.[1])
      .filter((d): d is string => !!d)
      .sort()
      .slice(-n)
  } catch {
    return []
  }
}

/** Parse ONE day's runlog into entries tagged with that date ('' if the file is missing). */
export function parseDay(dir: string, date: string): Entry[] {
  try {
    return parseEntries(readFileSync(`${dir}/${date}.md`, 'utf8'), date)
  } catch {
    return []
  }
}

/** Load+parse entries across the given dates, in order (oldest→newest). */
export function loadEntries(dir: string, dates: string[]): Entry[] {
  return dates.flatMap((d) => parseDay(dir, d))
}

/** The runlog CALENDAR: every `<date>.md` with its size + entry count, NEWEST first — the "what days
 * exist" map (replaces a `Glob` the gitignore would mangle). */
export function listDateFiles(dir: string): { date: string; entries: number; kb: number }[] {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  const out: { date: string; entries: number; kb: number }[] = []
  for (const f of files) {
    const m = f.match(DATE_RE)
    if (!m) continue
    try {
      const text = readFileSync(`${dir}/${f}`, 'utf8')
      const entries = (text.match(/\n## /g)?.length ?? 0) + (text.startsWith('## ') ? 1 : 0)
      out.push({ date: m[1], entries, kb: Math.round(text.length / 1024) })
    } catch {
      out.push({ date: m[1], entries: 0, kb: 0 })
    }
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1))
}

/** Keyword search across entries (the duck's THOUGHT + incoming text + its replies), newest-first.
 * Returns where each hit lives (date + tag) so the model can drill in with `recall_by_tag(tag, date)`. */
export function searchEntries(
  entries: Entry[],
  query: string,
  limit: number,
): { date: string; tag: string; when: number; who: string; snippet: string }[] {
  const q = query.toLowerCase()
  const hits: { date: string; tag: string; when: number; who: string; snippet: string }[] = []
  for (const e of entries) {
    const hay = [e.thought, ...e.incoming.map((i) => i.text), ...e.sent].join('  ·  ')
    const idx = hay.toLowerCase().indexOf(q)
    if (idx < 0) continue
    const snippet = hay
      .slice(Math.max(0, idx - 40), idx + query.length + 80)
      .replace(/\s+/g, ' ')
      .trim()
    hits.push({ date: e.date, tag: e.tags[0] ?? '', when: e.timestamp, who: e.incoming[0]?.from ?? '', snippet })
  }
  return hits.sort((a, b) => b.when - a.when).slice(0, limit)
}

// ---------------------------------------------------------------------------------------------------
// SELF-TRUST view (the `recall-self` MCP) — returns the duck's OWN post-firebreak output only: its
// `thought`, what it `sent`, the tags, and each entry's ORIGIN TRUST. It NEVER renders the raw
// untrusted `incoming`, so reading it does not lower the cycle's trust (safe at `trust: self`). Used by
// the activity-digest cron to distill chat activity into memory.
// ---------------------------------------------------------------------------------------------------

/** Trust ordering for the `min_trust` floor (higher = more trusted). Unknown/'' sorts as lowest. */
const TRUST_RANK: Record<string, number> = { self: 3, org: 2, public: 1 }
const trustRank = (t: string) => TRUST_RANK[t] ?? 0

/** Keep only entries whose origin trust is at or above `minTrust` (no floor → keep all). */
export function atLeastTrust(entries: Entry[], minTrust?: string): Entry[] {
  if (!minTrust) return entries
  const floor = trustRank(minTrust)
  return entries.filter((e) => trustRank(e.trust) >= floor)
}

/** Render the duck's OWN reasoning+output (thoughts + sent) per entry, labelled with tag + origin
 * trust — and NEVER the raw incoming text. This is the firebreak-clean view, safe at self-trust. */
export function renderThoughtLog(entries: Entry[]): string {
  if (!entries.length) return '(no recalled activity)'
  const lines: string[] = []
  for (const e of entries) {
    const tag = e.tags[0] ?? '?'
    const trust = e.trust || '?'
    if (e.thought) lines.push(`[${tag} · ${trust}] thought: ${e.thought}`)
    for (const s of e.sent) lines.push(`  ↳ you: ${s}`)
  }
  return lines.join('\n')
}

/** Recent activity across ALL chats (newest-last) for the digest: load the last `days`, drop entries
 * with no own-output (pure-noise perceives that thought nothing and sent nothing), apply the trust
 * floor. Returns Entries; the MCP renders them via `renderThoughtLog`. */
export function recentActivity(dir: string, days: number, minTrust?: string): Entry[] {
  const entries = loadEntries(dir, recentDates(dir, days)).filter((e) => e.thought || e.sent.length)
  return atLeastTrust(entries, minTrust)
}
