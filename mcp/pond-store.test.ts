import { describe, expect, test } from 'bun:test'
import { getCursor, mintHandle, openPondStore, restoreHandles, setCursor, spliceHandles } from './pond-store'

const T = 1_700_000_000

describe('handles (the envelope)', () => {
  test('mint → splice for the owner: value in, handle consumed', () => {
    const db = openPondStore(':memory:')
    const h = mintHandle(db, 'https://a.c.pond.city/?token=SECRET', '424242', 'configurator_url', 1800, T)
    expect(h).toMatch(/^H-[a-z0-9]{12}$/)
    const s = spliceHandles(db, `here is your link: ${h} — valid 30 min`, '424242', T + 5)
    expect(s).toEqual({
      ok: true,
      text: 'here is your link: https://a.c.pond.city/?token=SECRET — valid 30 min',
      spliced: 1,
      handles: [h],
    })
    // single-use: second splice refuses as consumed
    const again = spliceHandles(db, `${h}`, '424242', T + 6)
    expect(again).toEqual({ ok: false, handle: h, reason: 'consumed' })
  })

  test('wrong destination refuses and consumes nothing (replay in attacker chat)', () => {
    const db = openPondStore(':memory:')
    const h = mintHandle(db, 'SECRET', '424242', 'secret', 1800, T)
    const s = spliceHandles(db, `psst: ${h}`, '666', T + 5)
    expect(s).toEqual({ ok: false, handle: h, reason: 'wrong_destination' })
    // …and the rightful owner can still use it
    const ok = spliceHandles(db, h, '424242', T + 6)
    expect(ok.ok).toBe(true)
  })

  test('expiry and unknown', () => {
    const db = openPondStore(':memory:')
    const h = mintHandle(db, 'SECRET', '424242', 'secret', 60, T)
    expect(spliceHandles(db, h, '424242', T + 61)).toEqual({ ok: false, handle: h, reason: 'expired' })
    expect(spliceHandles(db, 'H-zzzzzzzzzzzz', '424242', T)).toEqual({
      ok: false,
      handle: 'H-zzzzzzzzzzzz',
      reason: 'unknown',
    })
  })

  test('all-or-nothing: one bad handle rolls back the good one', () => {
    const db = openPondStore(':memory:')
    const good = mintHandle(db, 'GOOD', '424242', 'secret', 1800, T)
    const other = mintHandle(db, 'THEIRS', '777', 'secret', 1800, T)
    const s = spliceHandles(db, `${good} and ${other}`, '424242', T + 5)
    expect(s.ok).toBe(false)
    // the good handle survived the rollback
    const retry = spliceHandles(db, good, '424242', T + 6)
    expect(retry).toMatchObject({ ok: true, text: 'GOOD', spliced: 1 })
  })

  test('no handle tokens → text passes through untouched', () => {
    const db = openPondStore(':memory:')
    const s = spliceHandles(db, 'plain reply, nothing enveloped (H-short is not a handle)', '424242', T)
    expect(s).toMatchObject({ ok: true, spliced: 0 })
  })

  test('restoreHandles: delivery failure makes the same handle work again', () => {
    const db = openPondStore(':memory:')
    const h = mintHandle(db, 'SECRET', '424242', 'secret', 1800, T)
    const s = spliceHandles(db, h, '424242', T + 5)
    expect(s.ok).toBe(true)
    restoreHandles(db, (s as any).handles, T + 5) // telegram send failed → roll back
    const retry = spliceHandles(db, h, '424242', T + 10)
    expect(retry).toMatchObject({ ok: true, text: 'SECRET' })
  })

  test('duplicate token in one text splices everywhere, consumes once', () => {
    const db = openPondStore(':memory:')
    const h = mintHandle(db, 'V', '1', 'secret', 1800, T)
    const s = spliceHandles(db, `${h} … again: ${h}`, '1', T + 1)
    expect(s).toMatchObject({ ok: true, text: 'V … again: V', spliced: 1 })
  })
})

describe('ingress cursor', () => {
  test('starts at 0, advances, never regresses', () => {
    const db = openPondStore(':memory:')
    expect(getCursor(db)).toBe(0)
    setCursor(db, 41)
    setCursor(db, 40) // out-of-order ack must not move it back
    expect(getCursor(db)).toBe(41)
    setCursor(db, 42)
    expect(getCursor(db)).toBe(42)
  })
})
