import { test, expect } from 'bun:test'
import { render, deliver } from './notify-router'

test('render: severity icon + title + body + source + source_chat', () => {
  const t = render({ severity: 'error', title: 'cycle failed', body: 'boom', source: 'harness', source_chat: '42' })
  expect(t).toContain('❌')
  expect(t).toContain('cycle failed')
  expect(t).toContain('boom')
  expect(t).toContain('source chat: 42')
  expect(t).toContain('— harness')
})

test('deliver: a log-only route is not wire-delivered; empty targets deliver nothing (no network)', async () => {
  // default routes: info → ['log'] (jsonl only); error/alert → ['telegram'] but default chat_ids is []
  expect((await deliver({ severity: 'info', title: 't', body: 'b' })).delivered).toBe(false)
  const err = await deliver({ severity: 'error', title: 't', body: 'b' })
  expect(err.delivered).toBe(false)
  expect(err.via).toEqual([]) // routed to telegram, but no configured chat_ids → nothing sent, no network
})
