import { test, expect } from 'bun:test'
import { routeFor, replyMeta } from './telegram-routing'

const cfg = { operator_ids: [80375347], operator_user_id: null, op_path: '/telegram/op', pub_path: '/telegram/pub', groups: { '-5416963964': '/telegram/trusted' } }

test('routing: a configured group wins over the operator id; operator DMs and unconfigured chats still go op', () => {
  expect(routeFor(cfg, 80375347, -5416963964, 'supergroup')).toMatchObject({ path: '/telegram/trusted' }) // the 2026-10-12 noise case
  expect(routeFor(cfg, 80375347, 80375347, 'private')).toMatchObject({ path: '/telegram/op' })
  expect(routeFor(cfg, 80375347, -1004351143165, 'supergroup')).toMatchObject({ path: '/telegram/op' }) // operator in an UNconfigured group
  expect(routeFor(cfg, 7898354400, -1004351143165, 'supergroup')).toMatchObject({ path: '/telegram/pub' })
  expect(routeFor({ ...cfg, group_path: '/telegram/group' }, 7898354400, -1004351143165, 'supergroup')).toMatchObject({ path: '/telegram/group' })
})

test('reply attribution: the parent inside the update names whom a message answers, and whether that is us', () => {
  const SELF = 8633788749
  const parentByOperator = { message_id: 1539, from: { id: 80375347, username: 'ilia_xbt' }, text: 'x'.repeat(300) }
  const r = replyMeta({ message_id: 1540, reply_to_message: parentByOperator }, SELF)
  expect(r).toMatchObject({ in_reply_to: 1539, reply_to: { message_id: 1539, from_user_id: 80375347, from_username: 'ilia_xbt', is_self: false } })
  expect(r!.reply_to.text.length).toBe(200)
  const toUs = replyMeta({ message_id: 2, reply_to_message: { message_id: 1, from: { id: SELF, username: 'looper_383_bot' }, photo: [{}] } }, SELF)
  expect(toUs).toMatchObject({ reply_to: { is_self: true, text: '[photo]' } })
  expect(replyMeta({ message_id: 3, text: 'plain' }, SELF)).toBeNull() // not a reply ⇒ payload unchanged
  expect(replyMeta({ message_id: 4, reply_to_message: { message_id: 1, sender_chat: { id: -100, title: 'Chan' }, text: 'hi' } }, SELF)!.reply_to).toMatchObject({ from_user_id: -100, is_self: false })
})
