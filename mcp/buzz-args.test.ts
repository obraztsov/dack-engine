import { test, expect } from 'bun:test'
import { DEFAULT_DENY, deniedVerb, rejectsHostPathFlag } from './buzz-args'

const DENY = DEFAULT_DENY.map((d) => d.toLowerCase())

test('denied verbs are caught by first positional and by "verb subverb"', () => {
  expect(deniedVerb(['agents', 'archive'], DENY)).toBe('agents')
  expect(deniedVerb(['messages', 'delete', '--id', 'x'], DENY)).toBe('messages delete')
  expect(deniedVerb(['channels', 'leave', '--channel', 'c'], DENY)).toBe('channels leave')
  // Flags must not shift the positional path (the verb check filters them out).
  expect(deniedVerb(['--format', 'json', 'messages', 'edit'], DENY)).toBe('messages edit')
})

test('REGRESSION: a flag VALUE cannot shift the positional path to bypass the deny-list', () => {
  // Was a real bypass: naive flag-filtering left ["json","messages","delete"], so the verb read as
  // "json" and `messages delete` executed. Every value-taking global must be transparent here.
  expect(deniedVerb(['--format', 'json', 'messages', 'delete', '--id', 'x'], DENY)).toBe('messages delete')
  expect(deniedVerb(['--format', 'compact', 'channels', 'delete'], DENY)).toBe('channels delete')
  expect(deniedVerb(['--auth-tag', '{}', 'agents', 'archive'], DENY)).toBe('agents')
  expect(deniedVerb(['--relay', 'https://evil.example', 'repos', 'push'], DENY)).toBe('repos')
  // `--flag=value` form too.
  expect(deniedVerb(['--format=json', 'channels', 'leave'], DENY)).toBe('channels leave')
  // A value-LESS flag before the verb must not hide it either (the naive backstop covers this).
  expect(deniedVerb(['--broadcast', 'messages', 'delete'], DENY)).toBe('messages delete')
})

test('a denied word appearing as a flag VALUE does not false-positive', () => {
  // `--content "agents"` is a legitimate message whose text happens to be a denied verb.
  expect(deniedVerb(['messages', 'send', '--content', 'agents'], DENY)).toBeNull()
  expect(deniedVerb(['--format', 'json', 'messages', 'send', '--content', 'projects'], DENY)).toBeNull()
})

test('allowed verbs pass, including ones whose PARENT has denied subverbs', () => {
  expect(deniedVerb(['messages', 'send', '--content', 'hi'], DENY)).toBeNull()
  expect(deniedVerb(['messages', 'get', '--channel', 'c'], DENY)).toBeNull()
  expect(deniedVerb(['channels', 'list'], DENY)).toBeNull()
  expect(deniedVerb(['media', 'get', 'abc'], DENY)).toBeNull()
  expect(deniedVerb(['dms', 'open', '--pubkey', 'ff'], DENY)).toBeNull()
})

test('an empty operator override disables the verb deny-list', () => {
  expect(deniedVerb(['channels', 'delete'], [])).toBeNull()
})

test('host-path flags are REFUSED on the generic tool and name the confined tool to use', () => {
  // --file reads+uploads any host path → the exfiltration shape this guard exists for.
  const f = rejectsHostPathFlag(['messages', 'send', '--content', 'x', '--file', '/duck/identities/soul'])
  expect(f).toEqual({ flag: '--file', use: 'send_file' })
  // -o/--output writes any host path → clobbering a soul file / secret.
  expect(rejectsHostPathFlag(['media', 'get', 'abc', '-o', '/duck/dack.config.yaml'])?.use).toBe('media_fetch')
  expect(rejectsHostPathFlag(['media', 'get', 'abc', '--output', '/tmp/x'])?.use).toBe('media_fetch')
  // `--flag=value` form must not slip past the check.
  expect(rejectsHostPathFlag(['messages', 'send', '--file=/etc/passwd'])?.flag).toBe('--file')
  expect(rejectsHostPathFlag(['media', 'get', 'a', '--output=/etc/x'])?.flag).toBe('--output')
  // Pre-emptive short alias (no `-f` in today's CLI, but a future one must not open the hole).
  expect(rejectsHostPathFlag(['messages', 'send', '-f', '/etc/passwd'])?.flag).toBe('-f')
})

test('ordinary argv is untouched — the guard is shape-specific, not path-sniffing', () => {
  expect(rejectsHostPathFlag(['messages', 'send', '--content', 'hi'])).toBeNull()
  expect(rejectsHostPathFlag(['channels', 'list'])).toBeNull()
  expect(rejectsHostPathFlag(['messages', 'get', '--channel', 'c', '--limit', '20'])).toBeNull()
  // A value that merely LOOKS like a path is fine — only the dangerous flags are refused.
  expect(rejectsHostPathFlag(['messages', 'send', '--content', 'see /etc/passwd lol'])).toBeNull()
  // A longer flag that merely starts with a denied one must not false-match.
  expect(rejectsHostPathFlag(['messages', 'send', '--filename', 'x.md'])).toBeNull()
})
