import { test, expect } from 'bun:test'
import { ownRepliesSummary, parseThreadEvents, type ThreadEv } from './buzz-thread'

const ME = 'a'.repeat(64)
const PEER = 'b'.repeat(64)
const ROOT = 'c'.repeat(64)
const ev = (id: string, pubkey: string, created_at: number, content: string, reply?: string): ThreadEv => ({
  id,
  pubkey,
  created_at,
  content,
  tags: reply ? [['e', ROOT, '', 'root'], ['e', reply, '', 'reply']] : [],
})

test('parses a bare array and the wrapped shapes, dropping junk', () => {
  const one = [ev('1', PEER, 1, 'hi')]
  expect(parseThreadEvents(JSON.stringify(one))).toHaveLength(1)
  expect(parseThreadEvents(JSON.stringify({ events: one }))).toHaveLength(1)
  expect(parseThreadEvents(JSON.stringify({ messages: [...one, null, { id: 7 }] }))).toHaveLength(1)
  expect(parseThreadEvents('not json')).toEqual([])
})

test('the progress-ping case: nothing new since my reply ⇒ says so', () => {
  // Jarvis asks (t=10), I answer (t=20), Jarvis posts "⏳ still working" (t=30) — wait, that IS new. The
  // duplicate case is a wake where the latest events are all BEFORE my reply (coalesced batch, resume).
  const evs = [ev('q', PEER, 10, 'two questions?'), ev('mine', ME, 20, 'answers to both', 'q')]
  const s = ownRepliesSummary(evs, ME, ROOT)
  expect(s.you_spoke).toBe(true)
  expect(s.own_count).toBe(1)
  expect(s.own[0]).toMatchObject({ id: 'mine', reply_to: 'q' })
  expect(s.since_your_last.count).toBe(0)
  expect(s.hint).toContain('NOTHING arrived after your last reply')
})

test('messages from others AFTER my last reply are surfaced, earlier ones are not', () => {
  const evs = [
    ev('q', PEER, 10, 'two questions?'),
    ev('mine', ME, 20, 'answers to both', 'q'),
    ev('ping', PEER, 30, '⏳ Working — 3 min', 'mine'),
    ev('mine-old', ME, 5, 'kickoff'),
  ]
  const s = ownRepliesSummary(evs, ME, ROOT)
  expect(s.own_count).toBe(2)
  expect(s.own.map((o) => o.id)).toEqual(['mine-old', 'mine']) // oldest → newest
  expect(s.last_own_at).toBe(new Date(20_000).toISOString())
  expect(s.since_your_last.count).toBe(1)
  expect(s.since_your_last.from_others[0]).toMatchObject({ id: 'ping', from: PEER.slice(0, 8) })
  expect(s.hint).toMatch(/^1 message\(s\) from others since your last reply/)
})

test('never spoke ⇒ no own entries and every message counts as unanswered context', () => {
  const s = ownRepliesSummary([ev('q', PEER, 10, 'hello?')], ME, ROOT)
  expect(s.you_spoke).toBe(false)
  expect(s.own).toEqual([])
  expect(s.last_own_at).toBeNull()
  expect(s.since_your_last.count).toBe(0) // nothing to measure "since" against
  expect(s.hint).toBe('you have not posted in this thread')
})

test('long bodies are clipped and lists are capped so a busy thread cannot blow the context', () => {
  const evs: ThreadEv[] = []
  for (let i = 0; i < 20; i++) evs.push(ev(`m${i}`, ME, i, 'x'.repeat(2000)))
  for (let i = 0; i < 20; i++) evs.push(ev(`p${i}`, PEER, 100 + i, 'y'.repeat(2000)))
  const s = ownRepliesSummary(evs, ME, ROOT)
  expect(s.own).toHaveLength(5)
  expect(s.own[0].content.length).toBeLessThanOrEqual(600)
  expect(s.since_your_last.count).toBe(20)
  expect(s.since_your_last.from_others).toHaveLength(6)
  expect(s.since_your_last.from_others[0].content.length).toBeLessThanOrEqual(240)
})
