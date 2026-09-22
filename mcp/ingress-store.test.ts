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
  recordReferral,
  getReferral,
  pendingReferrals,
  markReferralApplied,
  parseStartParam,
  recordSend,
  recentSends,
} from './ingress-store'

test('attachmentKind classifies by intrinsic category (independent of path config); multi-operator', () => {
  const groups = { '-100': '/telegram/trusted' }
  const OPS = [42, 43] // multi-operator list
  expect(attachmentKind(OPS, groups, 42, 999, 'private')).toBe('operator')
  expect(attachmentKind(OPS, groups, 43, 999, 'private')).toBe('operator') // second operator too
  expect(attachmentKind(OPS, groups, 7, -100, 'supergroup')).toBe('trusted')
  expect(attachmentKind(OPS, groups, 7, 555, 'private')).toBe('dm')
  expect(attachmentKind(OPS, groups, 7, -200, 'supergroup')).toBe('group')
  expect(attachmentKind(OPS, groups, 7, -300, 'channel')).toBe('pub')
  expect(attachmentKind([], {}, 7, 555, 'private')).toBe('dm') // no operators configured
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

test('attachmentsAllowed: `file` (document sent as-a-file) is a THIRD separate gate', () => {
  const db = openIngressStore(':memory:')
  // built-in defaults: operator/trusted/dm ON, group/pub OFF — same posture as image/voice
  expect(attachmentsAllowed(db, {}, '555', 'operator', 'file')).toBe(true)
  expect(attachmentsAllowed(db, {}, '555', 'dm', 'file')).toBe(true)
  expect(attachmentsAllowed(db, {}, '-200', 'group', 'file')).toBe(false)
  expect(attachmentsAllowed(db, {}, '999', 'pub', 'file')).toBe(false)
  // gated independently of image/voice: turning a chat's files OFF leaves images ON
  setChatAttachment(db, '555', 'file', false)
  expect(attachmentsAllowed(db, {}, '555', 'dm', 'file')).toBe(false)
  expect(attachmentsAllowed(db, {}, '555', 'dm', 'image')).toBe(true)
  // and a config default can flip files for a kind
  expect(attachmentsAllowed(db, { file: { group: true } }, '-200', 'group', 'file')).toBe(true)
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

test('parseStartParam accepts only a real deep-link param', () => {
  expect(parseStartParam('/start alice')).toBe('alice')
  expect(parseStartParam('/start@AgentDackBot ref_42-x')).toBe('ref_42-x') // /start@Bot form
  expect(parseStartParam('  /start  code123  ')).toBe('code123') // trimmed, extra space
  expect(parseStartParam('/start')).toBe(null) // bare start, no param
  expect(parseStartParam('/start ')).toBe(null)
  expect(parseStartParam('hello there')).toBe(null) // not a start command
  expect(parseStartParam('/started foo')).toBe(null) // not /start (word boundary via @/space)
  expect(parseStartParam('/start bad param')).toBe('bad') // first token only
  expect(parseStartParam('/start has spaces!')).toBe('has') // first token; '!' would fail charset anyway
  expect(parseStartParam('/start @evil/../x')).toBe(null) // out-of-charset (injection-shaped) → rejected
  expect(parseStartParam('/start ' + 'a'.repeat(65))).toBe(null) // > 64 chars → rejected
  expect(parseStartParam('/start ' + 'a'.repeat(64))).toBe('a'.repeat(64)) // exactly 64 ok
})

test('referrals: first-touch capture, pending queue, idempotent apply', () => {
  const db = openIngressStore(':memory:')
  expect(getReferral(db, '111')).toBe(null)

  // first touch records the param + referee username, seen_count 1
  const r1 = recordReferral(db, '111', 'alice', 'bob', '111', 1000)
  expect(r1.param).toBe('alice')
  expect(r1.username).toBe('bob')
  expect(r1.seen_count).toBe(1)
  expect(r1.created_at).toBe(1000)
  expect(r1.applied_at).toBe(null)

  // re-/start with a DIFFERENT link does NOT overwrite the referrer (first-touch); only seen/last advance
  const r2 = recordReferral(db, '111', 'carol', 'bob', '111', 2000)
  expect(r2.param).toBe('alice') // preserved
  expect(r2.created_at).toBe(1000) // preserved
  expect(r2.seen_count).toBe(2)
  expect(r2.last_seen_at).toBe(2000)

  // a second referee, captured later → appears after the first in the oldest-first pending queue
  recordReferral(db, '222', 'dave', 'eve', '222', 1500)
  const pending = pendingReferrals(db, 50)
  expect(pending.map((r) => r.user_id)).toEqual(['111', '222']) // created_at 1000 then 1500

  // marking applied is idempotent and drops it from the pending queue
  expect(markReferralApplied(db, '111', 3000)).toBe(true)
  expect(markReferralApplied(db, '111', 3001)).toBe(false) // already applied — no double-reward
  expect(getReferral(db, '111')?.applied_at).toBe(3000)
  expect(pendingReferrals(db, 50).map((r) => r.user_id)).toEqual(['222'])

  // applying a user with no referral is a no-op false (never throws)
  expect(markReferralApplied(db, '999', 4000)).toBe(false)
})

test('send audit: records every attempt (ok + failed), queryable per chat, newest first', () => {
  const db = openIngressStore(':memory:')
  recordSend(db, { via: 'reply', chatId: '555', ok: true, messageId: 3010, replyTo: '3004', chars: 120 }, 1000)
  recordSend(db, { via: 'reply', chatId: '555', ok: false, chars: 80, error: 'status 400 reply not found' }, 1001)
  recordSend(db, { via: 'send_message', chatId: '-200', ok: true, messageId: 7, chars: 40 }, 1002)

  const all = recentSends(db)
  expect(all.length).toBe(3)
  expect(all[0].via).toBe('send_message') // newest first

  const chat = recentSends(db, '555')
  expect(chat.length).toBe(2)
  expect(chat[0].ok).toBe(0)
  expect(chat[0].error).toContain('400')
  expect(chat[1].ok).toBe(1)
  expect(chat[1].message_id).toBe(3010)
  expect(chat[1].reply_to).toBe('3004')

  // a long error is truncated, not rejected (audit must never break the send path)
  recordSend(db, { via: 'reply', chatId: '555', ok: false, chars: 1, error: 'x'.repeat(5000) }, 1003)
  expect((recentSends(db, '555')[0].error ?? '').length).toBeLessThanOrEqual(500)
})
