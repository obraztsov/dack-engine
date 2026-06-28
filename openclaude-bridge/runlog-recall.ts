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
  runId: string
  state: string
  timestamp: number
  tags: string[]
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

/** Split the concatenated runlog into entries and parse each (skipping anything malformed). */
export function parseEntries(text: string): Entry[] {
  const blocks = text.split(/\n(?=## )/).filter((b) => b.startsWith('## '))
  const out: Entry[] = []
  for (const b of blocks) {
    const head = b.match(/^## (\S+) · (\w+)/)
    if (!head) continue
    const ts = b.match(/^- timestamp: (\d+)/m)
    const tagsLine = b.match(/^- tags: (.+)$/m)
    const tags = tagsLine ? tagsLine[1].split(',').map((t) => t.trim()).filter(Boolean) : []
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
      runId: head[1],
      state: head[2],
      timestamp: ts ? parseInt(ts[1], 10) : 0,
      tags,
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
