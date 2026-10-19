import { describe, expect, test } from 'bun:test'
import { parseCursorState, serializeCursorState, sinceFor } from './ingress-cursor'

describe('ingress cursor', () => {
  test('legacy flat cursor file loads with an empty seen-set', () => {
    const s = parseCursorState('{"chan-a":1792412296,"chan-b":1792316976}')
    expect(s.cursor).toEqual({ 'chan-a': 1792412296, 'chan-b': 1792316976 })
    expect(s.seen.size).toBe(0)
  })

  test('new shape round-trips; seen ids are pruned relative to the cursor, never by wall-clock age', () => {
    // Channel cursor 1000, tolerance 120: a poll re-fetches created_at >= 880, so 'late' (900) must survive even if it
    // is hours old by the clock; 'old' (700) can never be re-fetched and goes.
    const s = parseCursorState(JSON.stringify({ cursor: { c: 1000, 'c:reactions': 5 }, seen: { old: 700, late: 900 } }))
    const out = JSON.parse(serializeCursorState(s, 120))
    expect(out).toEqual({ cursor: { c: 1000, 'c:reactions': 5 }, seen: { late: 900 } })
    expect(s.seen.has('old')).toBe(false)
  })

  test('the lowest message cursor sets the floor; maxIds drops the oldest', () => {
    const s = parseCursorState(JSON.stringify({ cursor: { quiet: 500, busy: 5000 }, seen: { a: 400, b: 450, c: 4990, d: 5000 } }))
    let out = JSON.parse(serializeCursorState(s, 120))
    expect(Object.keys(out.seen).sort()).toEqual(['a', 'b', 'c', 'd']) // floor = 500-120-60 = 320 keeps all
    out = JSON.parse(serializeCursorState(s, 120, 2))
    expect(Object.keys(out.seen).sort()).toEqual(['c', 'd'])
  })

  test('no cursor yet → nothing pruned', () => {
    const s = parseCursorState(JSON.stringify({ cursor: {}, seen: { x: 1 } }))
    expect(JSON.parse(serializeCursorState(s, 120)).seen).toEqual({ x: 1 })
  })

  test('garbage or empty input yields an empty state', () => {
    expect(parseCursorState('').cursor).toEqual({})
    expect(parseCursorState('not json').cursor).toEqual({})
    expect(parseCursorState('[1,2]').cursor).toEqual({})
  })

  test('since re-reads a tolerance window behind the cursor; first run looks back', () => {
    // The 2026-10-19 drop: our own post advanced the cursor to 11:59:12; Jarvis's request was stamped 11:59:02.
    const cursor = 1792411152
    const since = sinceFor(cursor, 1792411160, 120, 3600)
    expect(since).toBe(cursor - 120)
    expect(since).toBeLessThan(1792411142)
    expect(sinceFor(undefined, 5000, 120, 3600)).toBe(1400)
    expect(sinceFor(50, 5000, 120, 3600)).toBe(0)
  })
})
