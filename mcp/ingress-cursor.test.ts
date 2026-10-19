import { describe, expect, test } from 'bun:test'
import { parseCursorState, serializeCursorState, sinceFor } from './ingress-cursor'

describe('ingress cursor', () => {
  test('legacy flat cursor file loads with an empty seen-set', () => {
    const s = parseCursorState('{"chan-a":1792412296,"chan-b":1792316976}')
    expect(s.cursor).toEqual({ 'chan-a': 1792412296, 'chan-b': 1792316976 })
    expect(s.seen.size).toBe(0)
  })

  test('new shape round-trips and prunes seen ids by age at save time', () => {
    const s = parseCursorState(JSON.stringify({ cursor: { c: 100 }, seen: { old: 10, fresh: 95 } }))
    expect(s.seen.get('old')).toBe(10)
    const out = JSON.parse(serializeCursorState(s, 100, 60))
    expect(out).toEqual({ cursor: { c: 100 }, seen: { fresh: 95 } })
    expect(s.seen.has('old')).toBe(false)
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
