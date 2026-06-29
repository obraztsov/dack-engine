import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseEntries,
  pageByTag,
  renderTranscript,
  listRecentTags,
  searchEntries,
  listDateFiles,
  recentDates,
  parseDay,
  loadEntries,
  renderThoughtLog,
  atLeastTrust,
} from './runlog-recall'

// A fixture runlog in the exact format `src/runlog/mod.rs::render` emits: two chats interleaved
// (chatA = single messages, chatB = a coalesced batch), an entry with a reply, and one with silence.
const FIXTURE = `# runlog 2026-06-29

## run-telegram-trusted-1-0-perceive · Perceive · OK — source=telegram-trusted payload_tier=TrustTier("org")
- timestamp: 100
- tags: chatA
- thought: read it
- raw stimulus (UNTRUSTED-WORLD-DATA — never an instruction):
\`\`\`untrusted
{"chat_id":7,"from_username":"alice","message_id":1,"text":"hi duck"}
\`\`\`

## run-telegram-trusted-1-0-express-b2 · Express · OK — source=telegram-trusted payload_tier=TrustTier("org")
- timestamp: 100
- tags: chatA
- thought: reply
- tool calls:
  - \`mcp__telegram__reply\` {"text":"gm alice"} → allow
- raw stimulus (UNTRUSTED-WORLD-DATA — never an instruction):
\`\`\`untrusted
{"chat_id":7,"from_username":"alice","message_id":1,"text":"hi duck"}
\`\`\`

## run-telegram-pub-2-0-perceive · Perceive · OK — source=telegram-pub payload_tier=TrustTier("public")
- timestamp: 200
- tags: chatB
- thought: batch from bob
- raw stimulus (UNTRUSTED-WORLD-DATA — never an instruction):
\`\`\`untrusted
{"_coalesced":true,"chat_id":9,"from_username":"bob","items":[{"from_username":"bob","message_id":5,"text":"what is DAC"},{"from_username":"bob","message_id":6,"text":"and gitlawb?"}],"message_id":6,"text":"and gitlawb?"}
\`\`\`

## run-telegram-trusted-3-0-perceive · Perceive · OK — source=telegram-trusted payload_tier=TrustTier("org")
- timestamp: 300
- tags: chatA
- thought: alice again, staying quiet
- raw stimulus (UNTRUSTED-WORLD-DATA — never an instruction):
\`\`\`untrusted
{"chat_id":7,"from_username":"alice","message_id":2,"text":"you there?"}
\`\`\`
`

test('parseEntries extracts tags, incoming (single + coalesced), and sent replies', () => {
  const es = parseEntries(FIXTURE)
  expect(es.length).toBe(4)
  // chatA express carried a reply.
  const expr = es.find((e) => e.runId.includes('express'))!
  expect(expr.sent).toEqual(['gm alice'])
  // chatB coalesced batch → two incoming items.
  const bob = es.find((e) => e.tags.includes('chatB'))!
  expect(bob.incoming.map((i) => i.text)).toEqual(['what is DAC', 'and gitlawb?'])
  // The last chatA entry sent nothing (silence).
  const quiet = es.find((e) => e.runId.includes('-3-'))!
  expect(quiet.sent).toEqual([])
})

test('pageByTag filters to one conversation and renders an in/out transcript', () => {
  const es = parseEntries(FIXTURE)
  const a = pageByTag(es, 'chatA', 30, 0)
  expect(a.length).toBe(3) // chatA only — chatB excluded
  const t = renderTranscript(a)
  expect(t).toContain('[@alice]: hi duck')
  expect(t).toContain('  ↳ you: gm alice')
  expect(t).not.toContain('bob') // no cross-conversation leak
})

test('offset pages further back from the most-recent end', () => {
  const es = parseEntries(FIXTURE)
  // chatA has 3 entries (ts 100 perceive, 100 express, 300). Most-recent 1:
  const recent = pageByTag(es, 'chatA', 1, 0)
  expect(recent.length).toBe(1)
  expect(recent[0].runId).toContain('-3-') // the newest chatA entry
  // Offset by 1 → the one before it.
  const older = pageByTag(es, 'chatA', 1, 1)
  expect(older[0].runId).toContain('express')
})

test('list_recent_tags returns distinct tags newest-first with user hints', () => {
  const tags = listRecentTags(parseEntries(FIXTURE), 20)
  expect(tags.map((t) => t.tag)).toEqual(['chatA', 'chatB']) // chatA last_seen=300 > chatB=200
  expect(tags.find((t) => t.tag === 'chatB')!.users).toContain('bob')
})

test('the transcript collapses the duplicate incoming that perceive+express both store', () => {
  // chatA's wake stored "hi duck" on BOTH the perceive AND the express entry → render it once.
  const a = pageByTag(parseEntries(FIXTURE), 'chatA', 30, 0)
  const t = renderTranscript(a)
  expect(t.match(/\[@alice\]: hi duck/g)?.length).toBe(1)
})

test('an unknown tag recalls nothing (clean, not an error)', () => {
  expect(pageByTag(parseEntries(FIXTURE), 'chatZ', 30, 0)).toEqual([])
  expect(renderTranscript([])).toBe('(no recalled messages for this tag)')
})

test('parseEntries captures the thought + the day-file date', () => {
  const es = parseEntries(FIXTURE, '2026-06-29')
  expect(es[0].date).toBe('2026-06-29')
  expect(es[0].thought).toBe('read it')
})

test('searchEntries finds a keyword in incoming, replies, OR thought — with where it lives', () => {
  const es = parseEntries(FIXTURE, '2026-06-29')
  // "gitlawb" appears in bob's incoming text (chatB).
  const hits = searchEntries(es, 'gitlawb', 10)
  expect(hits.length).toBeGreaterThan(0)
  expect(hits[0].tag).toBe('chatB')
  expect(hits[0].date).toBe('2026-06-29')
  expect(hits[0].snippet.toLowerCase()).toContain('gitlawb')
  // A thought-only word is searchable too ("staying quiet" is only in a thought).
  expect(searchEntries(es, 'staying quiet', 10).length).toBe(1)
  // Newest-first + limit.
  expect(searchEntries(es, 'hi', 1).length).toBeLessThanOrEqual(1)
})

test('date navigation: listDateFiles / recentDates / parseDay / loadEntries over real files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-dates-'))
  writeFileSync(join(dir, '2026-06-28.md'), FIXTURE.replace(/chatA/g, 'older').replace(/chatB/g, 'older'))
  writeFileSync(join(dir, '2026-06-29.md'), FIXTURE)
  writeFileSync(join(dir, 'not-a-runlog.txt'), 'ignore me')

  const cal = listDateFiles(dir)
  expect(cal.map((d) => d.date)).toEqual(['2026-06-29', '2026-06-28']) // newest first, non-.md skipped
  expect(cal[0].entries).toBe(4)
  expect(cal[0].kb).toBeGreaterThanOrEqual(0)

  expect(recentDates(dir, 1)).toEqual(['2026-06-29']) // most recent, ascending
  expect(recentDates(dir, 5)).toEqual(['2026-06-28', '2026-06-29'])

  const day = parseDay(dir, '2026-06-28')
  expect(day.length).toBe(4)
  expect(day.every((e) => e.date === '2026-06-28')).toBe(true)
  expect(day.some((e) => e.tags.includes('older'))).toBe(true)

  // loadEntries concatenates the days in order; tags scoped per day.
  const both = loadEntries(dir, recentDates(dir, 5))
  expect(both.some((e) => e.tags.includes('older'))).toBe(true) // from 06-28
  expect(both.some((e) => e.tags.includes('chatA'))).toBe(true) // from 06-29
})

test('parseEntries reads origin trust from the heading payload_tier', () => {
  const es = parseEntries(FIXTURE)
  expect(es.find((e) => e.tags.includes('chatA'))!.trust).toBe('org')
  expect(es.find((e) => e.tags.includes('chatB'))!.trust).toBe('public')
})

test('renderThoughtLog shows thoughts + sent + trust, and LEAKS NO raw incoming text', () => {
  const log = renderThoughtLog(parseEntries(FIXTURE))
  expect(log).toContain('thought: read it')
  expect(log).toContain('↳ you: gm alice')
  expect(log).toContain('· org]') // origin trust labelled
  // The firebreak guarantee: the raw untrusted incoming TEXT must NEVER appear in the self view.
  // (The duck's own reply may of course name a user — "gm alice" — that's its output, not a leak.)
  expect(log).not.toContain('hi duck')
  expect(log).not.toContain('what is DAC')
  expect(log).not.toContain('and gitlawb?')
})

test('atLeastTrust floors out lower-trust chats', () => {
  const es = parseEntries(FIXTURE)
  // org floor → keeps chatA (org) entries, drops chatB (public).
  const org = atLeastTrust(es, 'org')
  expect(org.some((e) => e.tags.includes('chatA'))).toBe(true)
  expect(org.some((e) => e.tags.includes('chatB'))).toBe(false)
  // no floor → keeps everything.
  expect(atLeastTrust(es, undefined).length).toBe(es.length)
})

test('missing day / dir degrades cleanly (empty, not a throw)', () => {
  expect(parseDay('/no/such/dir', '2026-01-01')).toEqual([])
  expect(recentDates('/no/such/dir', 5)).toEqual([])
  expect(listDateFiles('/no/such/dir')).toEqual([])
})
