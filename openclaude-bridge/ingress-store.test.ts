import { test, expect } from 'bun:test'
import {
  openIngressStore,
  attachmentKind,
  attachmentsAllowed,
  setChatAttachment,
  getChatAttachment,
} from './ingress-store'

test('attachmentKind classifies by intrinsic category (independent of path config)', () => {
  const groups = { '-100': '/telegram/trusted' }
  const OP = 42
  expect(attachmentKind(OP, groups, OP, 999, 'private')).toBe('operator') // operator anywhere
  expect(attachmentKind(OP, groups, 7, -100, 'supergroup')).toBe('trusted') // vetted group
  expect(attachmentKind(OP, groups, 7, 555, 'private')).toBe('dm') // a DM is always dm
  expect(attachmentKind(OP, groups, 7, -200, 'supergroup')).toBe('group') // open group
  expect(attachmentKind(OP, groups, 7, -300, 'channel')).toBe('pub') // broadcast channel
  expect(attachmentKind(null, {}, 7, 555, 'private')).toBe('dm') // no operator configured
})

test('attachmentsAllowed: DM on by default, group off, per-chat override wins', () => {
  const db = openIngressStore(':memory:')
  // built-in defaults
  expect(attachmentsAllowed(db, {}, '555', 'dm')).toBe(true)
  expect(attachmentsAllowed(db, {}, '-200', 'group')).toBe(false)
  expect(attachmentsAllowed(db, {}, '999', 'operator')).toBe(true)
  expect(attachmentsAllowed(db, {}, '-300', 'pub')).toBe(false)

  // the "duck enables a public client" case: an override row flips a group ON
  db.exec("INSERT INTO chat_attachments (chat_id, allowed, updated_at) VALUES ('-200', 1, 0)")
  expect(attachmentsAllowed(db, {}, '-200', 'group')).toBe(true)

  // an override can also turn a DM OFF (a noisy DM)
  db.exec("INSERT INTO chat_attachments (chat_id, allowed, updated_at) VALUES ('555', 0, 0)")
  expect(attachmentsAllowed(db, {}, '555', 'dm')).toBe(false)

  // a config default can flip a whole kind (e.g. DMs off globally) for a chat with no override
  expect(attachmentsAllowed(db, { dm: false }, '777', 'dm')).toBe(false)
})

test('setChatAttachment upserts + getChatAttachment reads (the MCP authoring path)', () => {
  const db = openIngressStore(':memory:')
  expect(getChatAttachment(db, '-500')).toBe(null) // no override yet → null (falls back to kind default)
  setChatAttachment(db, '-500', true) // the duck enables a group (a client)
  expect(getChatAttachment(db, '-500')).toBe(true)
  expect(attachmentsAllowed(db, {}, '-500', 'group')).toBe(true) // override beats the group=false default
  setChatAttachment(db, '-500', false) // and can turn it back off (upsert, not a second row)
  expect(getChatAttachment(db, '-500')).toBe(false)
  expect(db.query('SELECT COUNT(*) c FROM chat_attachments WHERE chat_id = ?').get('-500')).toEqual({ c: 1 })
})
