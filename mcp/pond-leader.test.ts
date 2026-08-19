import { afterAll, describe, expect, test } from 'bun:test'
import { LeaderError, leaderClient } from './pond-leader'

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
    respond = () => Response.json({ agent: {}, secrets: {}, balance: 3 }, { status: 201 })
    await c.createAgent('m6a', 'whoami', { openai_base_url: 'x' })
    expect(last!.method).toBe('POST')
    expect(last!.path).toBe('/v1/manager/agents')
    expect(last!.headers.get('authorization')).toBe('Bearer JWT')
    expect(last!.headers.get('x-acting-tg-id')).toBe('424242')
    expect(JSON.parse(last!.body)).toEqual({ name: 'm6a', template: 'whoami', config: { openai_base_url: 'x' }, secrets: {} })
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
