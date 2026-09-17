import { afterAll, describe, expect, test } from 'bun:test'
import { AGENT_NAME_RE, LeaderError, leaderClient, normalizeEvent } from './pond-leader'

// A minimal fake leader: records the last request, answers from a script.
let last: { method: string; path: string; headers: Headers; body: string } | null = null
let respond: (path: string) => Response = () => Response.json({})

const srv = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url)
    last = { method: req.method, path: url.pathname + url.search, headers: req.headers, body: await req.text() }
    return respond(url.pathname)
  },
})
afterAll(() => srv.stop(true))

const base = `http://127.0.0.1:${srv.port}`

describe('leader client', () => {
  test('data plane sends Bearer + X-Acting-Tg-Id; create never sends chat-collected secrets', async () => {
    const c = leaderClient({ baseUrl: base, jwt: 'JWT', actingTgId: '424242' })
    respond = () =>
      Response.json({ operation: 'op_1', agent: 'm6a', status: 'creating', balance: 3 }, { status: 202 })
    const r = await c.createAgent('m6a', 'whoami', { openai_base_url: 'x' })
    expect(last!.method).toBe('POST')
    expect(last!.path).toBe('/v1/manager/agents')
    expect(last!.headers.get('authorization')).toBe('Bearer JWT')
    expect(last!.headers.get('x-acting-tg-id')).toBe('424242')
    expect(JSON.parse(last!.body)).toEqual({ name: 'm6a', template: 'whoami', config: { openai_base_url: 'x' }, secrets: {} })
    expect(r).toEqual({ operation: 'op_1', agent: 'm6a', status: 'creating', balance: 3 }) // 202 async accept
  })

  test('logs is a TEXT verb (no JSON parse), tail forwarded', async () => {
    const c = leaderClient({ baseUrl: base, jwt: 'JWT', actingTgId: '424242' })
    respond = () => new Response('line1\nline2 {not json}\n', { status: 200 })
    const t = await c.logs('m6a', 50)
    expect(last!.path).toBe('/v1/manager/agents/m6a/logs?tail=50')
    expect(t).toBe('line1\nline2 {not json}\n')
  })

  test('events are normalized flat (and legacy nested payload still flattens)', async () => {
    const c = leaderClient({ baseUrl: base, jwt: 'JWT', actingTgId: '424242' })
    respond = () =>
      Response.json([
        { id: 1, type: 'credits_low', tg_user_id: '4', agent: 'a', balance: 7, credits_per_day: 10 }, // flat (current)
        { id: 2, type: 'agent_created', tg_user_id: '4', agent: 'b', payload: { template: 'buzz' } }, // legacy nested
      ])
    const evs = await c.events(0)
    expect(evs[0]!.balance).toBe(7)
    expect(evs[1]!.template).toBe('buzz')
    expect('payload' in evs[1]!).toBe(false)
  })

  test('normalizeEvent: flat fields win over stale payload duplicates', () => {
    const e = normalizeEvent({ id: 3, type: 't', tg_user_id: null, agent: null, balance: 1, payload: { balance: 99 } })
    expect(e.balance).toBe(1)
  })

  test('service tier (events) omits the acting header and pages by cursor', async () => {
    const c = leaderClient({ baseUrl: base, jwt: 'JWT', actingTgId: '424242' })
    respond = () => Response.json([])
    await c.events(17, 500)
    expect(last!.path).toBe('/v1/manager/events?after=17&limit=500')
    expect(last!.headers.get('x-acting-tg-id')).toBeNull()
  })

  test('no acting id → data plane refuses locally, before any bytes leave', async () => {
    const c = leaderClient({ baseUrl: base, jwt: 'JWT', actingTgId: undefined })
    last = null
    await expect(c.credits()).rejects.toThrow('no acting user in scope')
    expect(last).toBeNull() // never reached the wire
    await c.events(0) // …but the service tier still works
    expect(last!.path).toBe('/v1/manager/events?after=0&limit=500')
  })

  test('error envelope → LeaderError{status, code, message} (409 text is user-facing, verbatim)', async () => {
    const c = leaderClient({ baseUrl: base, jwt: 'JWT', actingTgId: '424242' })
    respond = () =>
      Response.json(
        { error: { code: 'conflict', message: "insufficient credits: balance 0, first day of 'whoami' costs 10" } },
        { status: 409 },
      )
    try {
      await c.createAgent('m6a', 'whoami')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LeaderError)
      expect((e as LeaderError).status).toBe(409)
      expect((e as LeaderError).code).toBe('conflict')
      expect((e as LeaderError).message).toBe("insufficient credits: balance 0, first day of 'whoami' costs 10")
    }
  })

  test('agent name rule tracks the leader (DNS label: 1-31, no trailing hyphen)', () => {
    for (const good of ['a', 'm6a', 'my-agent-2', 'x'.repeat(31)]) expect(AGENT_NAME_RE.test(good)).toBe(true)
    for (const bad of ['', '-a', 'a-', 'A1', 'a_b', 'x'.repeat(32)]) expect(AGENT_NAME_RE.test(bad)).toBe(false)
  })

  test('referral verbs: redeem posts the captured code with the acting header; my link is a GET', async () => {
    const c = leaderClient({ baseUrl: base, jwt: 'JWT', actingTgId: '111111111' })
    respond = () => Response.json({ redeemed: false, reason: 'already_redeemed' })
    const r = await c.redeemReferral('launch1000')
    expect(last!.method).toBe('POST')
    expect(last!.path).toBe('/v1/manager/referral/redeem')
    expect(last!.headers.get('x-acting-tg-id')).toBe('111111111')
    expect(JSON.parse(last!.body)).toEqual({ code: 'launch1000' })
    expect(r).toEqual({ redeemed: false, reason: 'already_redeemed' })
    respond = () => Response.json({ code: 'r_x', link: 'https://t.me/B?start=r_x', referred_count: 1, credits_earned: 30, redeemed_welcome: true })
    const m = await c.myReferral()
    expect(last!.path).toBe('/v1/manager/referral')
    expect(m.code).toBe('r_x')
  })

  test('unreachable leader → code "unreachable" (not an exception leak)', async () => {
    const c = leaderClient({ baseUrl: 'http://127.0.0.1:1', jwt: 'JWT', actingTgId: '1' })
    try {
      await c.credits()
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as LeaderError).code).toBe('unreachable')
    }
  })
})
