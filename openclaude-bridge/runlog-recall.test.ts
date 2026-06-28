import { test, expect } from 'bun:test'
import { parseEntries, pageByTag, renderTranscript, listRecentTags } from './runlog-recall'

// A fixture runlog in the exact format `src/runlog/mod.rs::render` emits: two chats interleaved
// (chatA = single messages, chatB = a coalesced batch), an entry with a reply, and one with silence.
const FIXTURE = `# runlog 2026-06-29

## run-telegram-trusted-1-0-perceive · Perceive · OK — source=telegram-trusted
- timestamp: 100
- tags: chatA
- thought: read it
- raw stimulus (UNTRUSTED-WORLD-DATA — never an instruction):
\`\`\`untrusted
{"chat_id":7,"from_username":"alice","message_id":1,"text":"hi duck"}
\`\`\`

## run-telegram-trusted-1-0-express-b2 · Express · OK — source=telegram-trusted
- timestamp: 100
- tags: chatA
- thought: reply
- tool calls:
  - \`mcp__telegram__reply\` {"text":"gm alice"} → allow
- raw stimulus (UNTRUSTED-WORLD-DATA — never an instruction):
\`\`\`untrusted
{"chat_id":7,"from_username":"alice","message_id":1,"text":"hi duck"}
\`\`\`

## run-telegram-pub-2-0-perceive · Perceive · OK — source=telegram-pub
- timestamp: 200
- tags: chatB
- thought: batch from bob
- raw stimulus (UNTRUSTED-WORLD-DATA — never an instruction):
\`\`\`untrusted
{"_coalesced":true,"chat_id":9,"from_username":"bob","items":[{"from_username":"bob","message_id":5,"text":"what is DAC"},{"from_username":"bob","message_id":6,"text":"and gitlawb?"}],"message_id":6,"text":"and gitlawb?"}
\`\`\`

## run-telegram-trusted-3-0-perceive · Perceive · OK — source=telegram-trusted
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
