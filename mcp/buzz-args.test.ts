import { test, expect } from 'bun:test'
import { DEFAULT_DENY, deniedVerb, rejectsHostPathFlag, applySendDefaults, flagValue } from './buzz-args'

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
  expect(deniedVerb(['--relay', 'https://evil.example', 'workflows', 'run'], DENY)).toBe('workflows')
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

test('the git workspace is OPEN: projects, repos, issues, canvas, patches, PRs', () => {
  // Operator decision: a fleet with a git workspace must be able to USE it. Only the irreversible
  // tombstone (`projects delete`) and the org's rooms (channels create/update/delete) stay out.
  for (const argv of [
    ['projects', 'create', 'my-slug', '--channel', 'uuid'],
    ['projects', 'list', '--owner', 'ff'],
    ['projects', 'add-repo', '--repo', 'r'],
    ['repos', 'create', '--id', 'r'],
    ['repos', 'bind', '--channel', 'uuid'],
    ['issues', 'create', '--title', 't', '--content', 'c'],
    ['issues', 'assign', '--issue', 'e', '--assignee', 'ff'],
    ['issues', 'status', '--issue', 'e', '--status', 'resolved'],
    ['canvas', 'set', '--channel', 'uuid', '--content', '-'],
    ['canvas', 'history', '--channel', 'uuid'],
    ['patches', 'send', '--content', 'd'],
    ['pr', 'open', '--title', 't'],
    ['upload', 'file', 'x.md'],
    ['mem', 'set', 'slug', 'v'],
  ]) {
    expect(deniedVerb(argv, DENY)).toBeNull()
  }
})

test('still denied: the tombstone, the rooms, identity/automation, moderation', () => {
  expect(deniedVerb(['projects', 'delete', '--slug', 's'], DENY)).toBe('projects delete')
  expect(deniedVerb(['channels', 'create', '--name', 'n'], DENY)).toBe('channels create')
  expect(deniedVerb(['channels', 'delete'], DENY)).toBe('channels delete')
  expect(deniedVerb(['agents', 'draft-create'], DENY)).toBe('agents')
  expect(deniedVerb(['moderation', 'ban', '--pubkey', 'ff'], DENY)).toBe('moderation')
  // ...and the flag-value bypass must not resurrect any of them
  expect(deniedVerb(['--format', 'json', 'projects', 'delete'], DENY)).toBe('projects delete')
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

// ── applySendDefaults: the wake-scoped send defaults ──────────────────────────────────────────────
// REGRESSION GUARD. The reply-to default used to be applied whenever the flag was absent, so a send aimed
// at ANOTHER channel got the wake event (which lives in the WOKE channel) as its parent, and the relay
// refused the whole event: "parent event belongs to a different channel". Every cross-channel post broke,
// including send_file — the ducks staged documents correctly and the relay silently rejected them.

const WOKE = 'c747e8d2-cccc-cccc-cccc-cclevelcclevel'
const OTHER = 'a40b643f-rrrr-rrrr-rrrr-researchresear'
const ENV = { replyChannel: WOKE, replyTo: 'wake-event-id' }

test('a bare reply defaults to the woke channel AND threads under the wake event', () => {
  const out = applySendDefaults(['messages', 'send', '--content', 'hi'], ENV)
  expect(flagValue(out, '--channel')).toBe(WOKE)
  expect(flagValue(out, '--reply-to')).toBe('wake-event-id')
})

test('CROSS-CHANNEL send gets NO reply-to (the bug that blocked every document)', () => {
  const out = applySendDefaults(['messages', 'send', '--channel', OTHER, '--content', 'brief'], ENV)
  expect(flagValue(out, '--channel')).toBe(OTHER) // target preserved
  expect(out).not.toContain('--reply-to') // ← the fix: no foreign parent
  // the same shape send_file builds (with --file) must also stay parent-free
  const withFile = applySendDefaults(
    ['messages', 'send', '--channel', OTHER, '--content', 'brief', '--file', '/duck/media/x.md'], ENV)
  expect(withFile).not.toContain('--reply-to')
})

test('naming the WOKE channel explicitly still threads (it is the same conversation)', () => {
  const out = applySendDefaults(['messages', 'send', '--channel', WOKE, '--content', 'reply'], ENV)
  expect(flagValue(out, '--reply-to')).toBe('wake-event-id')
  // `--channel=<id>` form too
  const eq = applySendDefaults(['messages', 'send', `--channel=${WOKE}`, '--content', 'r'], ENV)
  expect(flagValue(eq, '--reply-to')).toBe('wake-event-id')
})

test('an explicit reply-to from the model is never overridden', () => {
  const out = applySendDefaults(['messages', 'send', '--reply-to', 'mine', '--content', 'x'], ENV)
  expect(flagValue(out, '--reply-to')).toBe('mine')
  expect(out.filter((a) => a === '--reply-to').length).toBe(1)
})

test('non-send verbs are untouched, and a wake with no scope adds nothing', () => {
  const read = ['messages', 'get', '--channel', OTHER, '--limit', '10']
  expect(applySendDefaults(read, ENV)).toEqual(read)
  expect(applySendDefaults(['channels', 'list'], ENV)).toEqual(['channels', 'list'])
  // heartbeat / self cycles carry no BUZZ_REPLY_* at all → the model's argv stands alone
  const bare = ['messages', 'send', '--channel', OTHER, '--content', 'x']
  expect(applySendDefaults(bare, {})).toEqual(bare)
})

test('send-diff gets the same treatment as send', () => {
  expect(applySendDefaults(['messages', 'send-diff', '--channel', OTHER, '--content', 'd'], ENV))
    .not.toContain('--reply-to')
  expect(flagValue(applySendDefaults(['messages', 'send-diff', '--content', 'd'], ENV), '--reply-to'))
    .toBe('wake-event-id')
})

// ── readOnlyVerb: the Perceive allowlist (fail-closed) ─────────────────────────────────────────────
import { readOnlyVerb } from './buzz-args'

test('read verbs pass the allowlist and return their verb path', () => {
  expect(readOnlyVerb(['messages', 'thread', '--channel', 'c', '--event', 'e'])).toBe('messages thread')
  expect(readOnlyVerb(['--format', 'json', 'projects', 'list', '--owner', 'ff'])).toBe('projects list')
  expect(readOnlyVerb(['issues', 'get', '--event', 'e'])).toBe('issues get')
  expect(readOnlyVerb(['canvas', 'history', '--channel', 'c'])).toBe('canvas history')
  expect(readOnlyVerb(['channels', 'members', '--channel', 'c'])).toBe('channels members')
})

test('every WRITE verb is refused — an allowlist, not a deny-list', () => {
  for (const argv of [
    ['messages', 'send', '--content', 'x'],
    ['messages', 'send-diff', '--content', 'x'],
    ['canvas', 'set', '--channel', 'c', '--content', 'x'],
    ['canvas', 'restore', '--channel', 'c', '--revision', 'r'],
    ['issues', 'create', '--title', 't', '--content', 'c'],
    ['issues', 'status', '--issue', 'i', '--status', 'resolved'],
    ['issues', 'assign', '--issue', 'i', '--assignee', 'a'],
    ['projects', 'create', 's'],
    ['repos', 'create', '--id', 'r'],
    ['upload', 'file', 'x'],
    ['mem', 'set', 'k', 'v'],
    ['media', 'get', 'sha'], // fetches bytes to disk — not a context read
    ['channels', 'join', '--channel', 'c'],
    ['agents', 'archive'],
    ['nonsense'],
  ]) {
    expect(readOnlyVerb(argv)).toBeNull()
  }
})

test('the flag-value bypass cannot smuggle a write past the read allowlist', () => {
  // naive parse would read ["json","messages","get"] → "json messages" (not allowed) → refused anyway;
  // the dangerous direction is a WRITE hidden behind a flag value: both parses must agree it is a read.
  expect(readOnlyVerb(['--format', 'json', 'messages', 'send', '--content', 'x'])).toBeNull()
  expect(readOnlyVerb(['--auth-tag', '{}', 'canvas', 'set', '--channel', 'c', '--content', 'x'])).toBeNull()
  // ...and a legitimately-prefixed read still passes
  expect(readOnlyVerb(['--format', 'compact', 'messages', 'get', '--channel', 'c'])).toBe('messages get')
})
