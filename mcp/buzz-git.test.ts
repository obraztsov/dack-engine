import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remoteUrl, cloneDirName, resolveRepoDir, confinePaths, gitHardening, gitIdentity } from './buzz-git'

const OWNER = '711601c80b19a808432252cc70b6b36dfeb2083f11396fc881290c6f7536da90'

test('remote URLs are CONSTRUCTED from validated parts — never model-supplied', () => {
  const r = remoteUrl('https://buzz-dlc.a.pond.city/', OWNER, 'looper-onboarding-app')
  expect(r).toMatchObject({ ok: true, url: `https://buzz-dlc.a.pond.city/git/${OWNER}/looper-onboarding-app` })
  expect(remoteUrl('https://relay', 'jarvis', 'x').ok).toBe(false) // a name is not an owner (64-hex)
  expect(remoteUrl('https://relay', OWNER, '../etc').ok).toBe(false)
  expect(remoteUrl('https://relay', OWNER, 'a/b').ok).toBe(false)
  expect(remoteUrl('file:///tmp', OWNER, 'x').ok).toBe(false)
})

test('clone dir names and commit paths are confined; a symlink out of repos/ is refused', () => {
  expect(cloneDirName(undefined, 'repo-1')).toMatchObject({ ok: true, name: 'repo-1' })
  expect(cloneDirName('../x', 'r').ok).toBe(false)
  expect(cloneDirName('.hidden', 'r').ok).toBe(false)
  const ws = mkdtempSync(join(tmpdir(), 'dack-bg-'))
  mkdirSync(join(ws, 'repos/good/.git'), { recursive: true })
  mkdirSync(join(ws, 'repos/notgit'), { recursive: true })
  mkdirSync(join(ws, 'outside/.git'), { recursive: true })
  symlinkSync(join(ws, 'outside'), join(ws, 'repos/link'))
  expect(resolveRepoDir(ws, 'good')).toMatchObject({ ok: true, name: 'good' })
  expect(resolveRepoDir(ws, 'repos/good')).toMatchObject({ ok: true }) // basename tolerated
  expect(resolveRepoDir(ws, 'notgit').ok).toBe(false)
  expect(resolveRepoDir(ws, 'link').ok).toBe(false) // escapes via symlink
  expect(resolveRepoDir(ws, 'missing').ok).toBe(false)
  expect(resolveRepoDir(undefined, 'good').ok).toBe(false)
  const repo = join(ws, 'repos/good')
  expect(confinePaths(repo, ['docs/a.md', join(repo, 'b.md')])).toMatchObject({ ok: true, rel: ['docs/a.md', 'b.md'] })
  expect(confinePaths(repo, ['../../outbox/x']).ok).toBe(false)
  expect(confinePaths(repo, ['.git/config']).ok).toBe(false)
  expect(confinePaths(repo, undefined)).toMatchObject({ ok: true, rel: [] })
  rmSync(ws, { recursive: true, force: true })
})

test('git hardening disables hooks/filters/non-https protocols/prompts and sets the Buzz identity', () => {
  const id = gitIdentity(OWNER, 'https://buzz-dlc.a.pond.city')
  expect(id).toEqual({ name: 'buzz:711601c80b19', email: '711601c80b19@buzz-dlc.a.pond.city' })
  const h = gitHardening(id).join(' ')
  for (const must of ['core.hooksPath=/dev/null', 'protocol.allow=never', 'protocol.https.allow=always', 'credential.helper=', 'submodule.recurse=false', 'user.name=buzz:711601c80b19']) {
    expect(h).toContain(must)
  }
})
