import { test, expect } from 'bun:test'
import { openRoutesStore, armThread, lookupArm, listArms, sanitizeTags } from './ingress-routes'

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
