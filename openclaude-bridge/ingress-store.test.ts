import { test, expect } from 'bun:test'
import {
  openIngressStore,
  attachmentKind,
  attachmentsAllowed,
  setChatAttachment,
  getChatAttachment,
  voiceUsageToday,
  addVoiceUsage,
  voiceWithinCap,
} from './ingress-store'

test('attachmentKind classifies by intrinsic category (independent of path config)', () => {
  const groups = { '-100': '/telegram/trusted' }
  const OP = 42
  expect(attachmentKind(OP, groups, OP, 999, 'private')).toBe('operator')
  expect(attachmentKind(OP, groups, 7, -100, 'supergroup')).toBe('trusted')
  expect(attachmentKind(OP, groups, 7, 555, 'private')).toBe('dm')
  expect(attachmentKind(OP, groups, 7, -200, 'supergroup')).toBe('group')
  expect(attachmentKind(OP, groups, 7, -300, 'channel')).toBe('pub')
  expect(attachmentKind(null, {}, 7, 555, 'private')).toBe('dm')
})

test('attachmentsAllowed: per-media defaults + override; image and voice are gated SEPARATELY', () => {
  const db = openIngressStore(':memory:')
  // built-in defaults (both media): dm on, group off
  expect(attachmentsAllowed(db, {}, '555', 'dm', 'image')).toBe(true)
  expect(attachmentsAllowed(db, {}, '555', 'dm', 'voice')).toBe(true)
  expect(attachmentsAllowed(db, {}, '-200', 'group', 'image')).toBe(false)
  expect(attachmentsAllowed(db, {}, '-200', 'group', 'voice')).toBe(false)

  // enable IMAGE for a group — voice stays OFF (separate gate = the granularity the operator wanted)
  setChatAttachment(db, '-200', 'image', true)
  expect(attachmentsAllowed(db, {}, '-200', 'group', 'image')).toBe(true)
  expect(attachmentsAllowed(db, {}, '-200', 'group', 'voice')).toBe(false)

  // a config default can flip a whole (media,kind) e.g. voice off in DMs globally
  expect(attachmentsAllowed(db, { voice: { dm: false } }, '777', 'dm', 'voice')).toBe(false)
  expect(attachmentsAllowed(db, { voice: { dm: false } }, '777', 'dm', 'image')).toBe(true) // image unaffected
})

test('set/getChatAttachment upsert per (chat, media)', () => {
  const db = openIngressStore(':memory:')
  expect(getChatAttachment(db, '-500', 'voice')).toBe(null)
  setChatAttachment(db, '-500', 'voice', true)
  expect(getChatAttachment(db, '-500', 'voice')).toBe(true)
  expect(getChatAttachment(db, '-500', 'image')).toBe(null) // image untouched
  setChatAttachment(db, '-500', 'voice', false) // upsert, not a 2nd row
  expect(getChatAttachment(db, '-500', 'voice')).toBe(false)
  expect(db.query('SELECT COUNT(*) c FROM chat_attachments WHERE chat_id = ?').get('-500')).toEqual({ c: 1 })
})

test('voice usage cap: accumulates per user/day and enforces the limit', () => {
  const db = openIngressStore(':memory:')
  const day = '2026-08-04'
  expect(voiceUsageToday(db, 'u1', day)).toBe(0)
  expect(voiceWithinCap(db, 'u1', day, 100, 3600)).toBe(true)
  addVoiceUsage(db, 'u1', day, 3500)
  expect(voiceUsageToday(db, 'u1', day)).toBe(3500)
  expect(voiceWithinCap(db, 'u1', day, 100, 3600)).toBe(true) // 3500+100 = 3600 ≤ 3600
  expect(voiceWithinCap(db, 'u1', day, 200, 3600)).toBe(false) // 3500+200 > 3600
  addVoiceUsage(db, 'u1', day, 100) // now 3600
  expect(voiceWithinCap(db, 'u1', day, 1, 3600)).toBe(false)
  expect(voiceWithinCap(db, 'u2', day, 1, 3600)).toBe(true) // a different user is independent
  expect(voiceWithinCap(db, 'u1', '2026-08-05', 1, 3600)).toBe(true) // a new day resets
  expect(voiceWithinCap(db, 'u1', day, 1, 0)).toBe(false) // limit 0 ⇒ voice disabled
})
