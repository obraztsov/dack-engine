import { test, expect } from 'bun:test'
import { openRoutesStore, armThread, lookupArm, listArms, sanitizeTags, upsertChannels, resolveChannel, channelDirectoryLine } from './ingress-routes'

test('arm → lookup round-trips; re-arming the same thread REPLACES (one stance per thread)', () => {
  const db = openRoutesStore(':memory:')
  armThread(db, { thread_root: 'r1', channel: 'c', entry_hint: 'reply', tags: ['issue:4df1', 'project:lo'], armed_by: 'me', ttl_secs: 3600 }, 1000)
  expect(lookupArm(db, 'r1', 1001)).toMatchObject({ entry_hint: 'reply', tags: ['issue:4df1', 'project:lo'] })
  armThread(db, { thread_root: 'r1', channel: 'c', entry_hint: 'review', tags: [], armed_by: 'me', ttl_secs: 3600 }, 1002)
  expect(lookupArm(db, 'r1', 1003)?.entry_hint).toBe('review')
  expect(listArms(db, 1003).length).toBe(1)
})

test('arms EXPIRE — a stale arm must not route unrelated replies forever', () => {
  const db = openRoutesStore(':memory:')
  armThread(db, { thread_root: 'r1', channel: 'c', entry_hint: 'reply', tags: [], armed_by: 'me', ttl_secs: 60 }, 1000)
  expect(lookupArm(db, 'r1', 1059)).not.toBeNull()
  expect(lookupArm(db, 'r1', 1060)).toBeNull() // purged at expiry
  expect(listArms(db, 1060)).toEqual([])
  // ttl floor: a hostile/buggy ttl of 0 still lives 60s, never 0 (a zero-length arm is a no-op bug)
  const r = armThread(db, { thread_root: 'r2', channel: 'c', entry_hint: 'reply', tags: [], armed_by: 'me', ttl_secs: 0 }, 2000)
  expect(r.expires_at).toBe(2060)
})

test('tags are sanitized index keys: bounded count, charset, length; junk dropped', () => {
  expect(sanitizeTags(['issue:abc', 'project:x-y_z.1/2', ' ok ', 'bad tag', '', 'a'.repeat(81), 7, null])).toEqual(['issue:abc', 'project:x-y_z.1/2', 'ok'])
  expect(sanitizeTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length).toBe(8)
  expect(sanitizeTags('not-an-array')).toEqual([])
  expect(sanitizeTags(['-leading-dash'])).toEqual([]) // must start alphanumeric (no flag-looking tags)
})

test('channel index: a NAME resolves to its id, an id passes through labelled, unknown/ambiguous REFUSE with the directory', () => {
  const db = openRoutesStore(':memory:')
  upsertChannels(db, [
    { id: 'a40b643f-8143-4e57-8878-0f19d15e0ca1', name: 'research', trust: 'org', configured: true },
    { id: '8ab41403-5c36-4541-b767-1245b794a9ef', name: 'marketing', trust: 'public', configured: false },
  ], 1000)
  expect(resolveChannel(db, 'research')).toMatchObject({ ok: true, id: 'a40b643f-8143-4e57-8878-0f19d15e0ca1', name: 'research', trust: 'org', configured: true })
  expect(resolveChannel(db, '#Research')).toMatchObject({ ok: true, name: 'research' }) // case + leading # tolerated
  // the live incident: an id is honoured but comes back NAMED, so "forwarded to research" can be checked
  expect(resolveChannel(db, '8ab41403-5c36-4541-b767-1245b794a9ef')).toMatchObject({ ok: true, name: 'marketing', trust: 'public', configured: false })
  // an id the index has never seen (a DM channel) still passes — this is a cache, not a gate on ids
  expect(resolveChannel(db, 'f'.repeat(64))).toMatchObject({ ok: true, name: null })
  const bad = resolveChannel(db, 'reserch')
  expect(bad.ok).toBe(false)
  if (!bad.ok) expect(bad.error).toContain('research') // the directory is in the refusal
  upsertChannels(db, [
    { id: '11111111-1111-1111-1111-111111111111', name: 'dup', trust: 'org', configured: false },
    { id: '22222222-2222-2222-2222-222222222222', name: 'dup', trust: 'org', configured: false },
  ])
  expect(resolveChannel(db, 'dup')).toMatchObject({ ok: false })
  expect(resolveChannel(db, 'research')).toMatchObject({ ok: false }) // upsert REPLACES: gone from the relay ⇒ gone here
  expect(channelDirectoryLine(db)).toBe('dup (org, unconfigured) · dup (org, unconfigured)')
})
