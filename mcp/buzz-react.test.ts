import { test, expect } from 'bun:test'
import { validateEmoji, parseReactionsOut } from './buzz-react'
import { openRoutesStore, upsertReactions, reactionsFor, deleteReaction, summarizeReactions } from './ingress-routes'
import { ownRepliesSummary } from './buzz-thread'

test('validateEmoji: one emoji or a :shortcode:, nothing else', () => {
  for (const ok of ['👀', '👍', '✅', '🙏', '👍🏽', '❤️', '🇱🇹', '🧑‍💻', ':party_parrot:', ' 🚀 '])
    expect(validateEmoji(ok).ok).toBe(true)
  for (const bad of ['', 'ok', '👀👀', 'thanks 👍', 'a', '::', 42, null, '👍 nice'])
    expect(validateEmoji(bad as any).ok).toBe(false)
  expect(validateEmoji(' 🚀 ')).toEqual({ ok: true, emoji: '🚀' })
})

test('parseReactionsOut tolerates both CLI shapes', () => {
  const a = parseReactionsOut('{"reactions":[{"pubkey":"ab","content":"👀","created_at":5,"id":"x"}]}')
  expect(a).toEqual([{ pubkey: 'ab', emoji: '👀', created_at: 5, id: 'x' }])
  expect(parseReactionsOut('[{"pubkey":"cd","emoji":"✅","created_at":6}]')[0]).toMatchObject({ pubkey: 'cd', emoji: '✅', id: null })
  expect(parseReactionsOut('garbage')).toEqual([])
  expect(parseReactionsOut('{"reactions":[]}')).toEqual([])
})

test('reactions store: idempotent upsert, per-target read, own removal, summary folds per emoji', () => {
  const db = openRoutesStore(':memory:')
  const T = 'f'.repeat(64)
  const rows = [
    { event_id: 'r1', target_id: T, channel: 'c', pubkey: 'jarvis00', emoji: '👀', created_at: 10 },
    { event_id: 'r2', target_id: T, channel: 'c', pubkey: 'peer0000', emoji: '👀', created_at: 11 },
    { event_id: 'r3', target_id: T, channel: 'c', pubkey: 'self0000', emoji: '✅', created_at: 12 },
    { event_id: 'r4', target_id: 'other', channel: 'c', pubkey: 'jarvis00', emoji: '👍', created_at: 13 },
  ]
  expect(upsertReactions(db, rows)).toBe(4)
  expect(upsertReactions(db, rows)).toBe(0) // same reaction events again → nothing new
  expect(reactionsFor(db, T)).toHaveLength(3)
  const sum = summarizeReactions(reactionsFor(db, T), (p) => (p === 'self0000' ? 'you' : p.slice(0, 6)))
  expect(sum).toEqual([
    { emoji: '👀', count: 2, by: ['jarvis', 'peer00'] },
    { emoji: '✅', count: 1, by: ['you'] },
  ])
  expect(deleteReaction(db, T, 'self0000', '✅')).toBe(1)
  expect(reactionsFor(db, T)).toHaveLength(2)
  // a row without a target or emoji is skipped, not stored
  expect(upsertReactions(db, [{ event_id: 'r9', target_id: '', channel: 'c', pubkey: 'x', emoji: '👀', created_at: 1 }])).toBe(0)
})

test('own_replies: a 👀 on your last post reads as the acknowledgement it is', () => {
  const self = 's'.repeat(64)
  const root = 'a'.repeat(64)
  const mine = 'b'.repeat(64)
  const evs = [
    { id: root, pubkey: 'h'.repeat(64), content: 'who owns the runbook?', created_at: 100 },
    { id: mine, pubkey: self, content: 'me — draft by tonight', created_at: 110, tags: [['e', root, '', 'reply']] },
  ]
  const reactionsOf = (id: string) => (id === mine ? [{ emoji: '👀', count: 1, by: ['hermes'] }] : [])
  const s = ownRepliesSummary(evs, self, root, { reactionsOf })
  expect(s.own[0].reactions).toEqual([{ emoji: '👀', count: 1, by: ['hermes'] }])
  expect(s.hint).toContain('acknowledged with 👀')
  // your OWN reaction on your own post is not an acknowledgement
  const s2 = ownRepliesSummary(evs, self, root, { reactionsOf: (id) => (id === mine ? [{ emoji: '✅', count: 1, by: ['you'] }] : []) })
  expect(s2.hint).not.toContain('acknowledged')
  // no reactions → shape unchanged (no `reactions` key at all)
  const s3 = ownRepliesSummary(evs, self, root)
  expect('reactions' in s3.own[0]).toBe(false)
})
