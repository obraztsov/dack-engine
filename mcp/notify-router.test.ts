import { test, expect } from 'bun:test'
import { render, deliver, dedupKey } from './notify-router'

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

test('dedupKey: a RECURRING condition collapses even when the body varies per occurrence', () => {
  // REGRESSION. The key used to include `body`, and both harness producers embedded the stimulus id
  // (in the title AND the body) — so every occurrence was a unique key and the dedup window never
  // collapsed anything: a duck stuck in a failing loop would page the operator once per wake, forever.
  const fail = (body: string) => ({ severity: 'error' as const, source: 'harness', title: 'cycle failed: heartbeat', body })

  // same condition, different per-occurrence detail → ONE key
  expect(dedupKey(fail('timeout after 300s (stimulus heartbeat-1)')))
    .toBe(dedupKey(fail('timeout after 300s (stimulus heartbeat-2)')))

  // a DIFFERENT condition must still get its own key — dedup must never swallow an unrelated fault
  expect(dedupKey({ severity: 'error', source: 'harness', title: 'cycle failed: project-sweep', body: 'x' }))
    .not.toBe(dedupKey(fail('x')))

  // severity and source are part of the identity
  expect(dedupKey({ severity: 'alert', source: 'harness', title: 'same', body: 'b' }))
    .not.toBe(dedupKey({ severity: 'error', source: 'harness', title: 'same', body: 'b' }))
  expect(dedupKey({ severity: 'error', source: 'notify-mcp', title: 'same', body: 'b' }))
    .not.toBe(dedupKey({ severity: 'error', source: 'harness', title: 'same', body: 'b' }))
})
