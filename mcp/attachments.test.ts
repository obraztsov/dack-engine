import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveAttachment } from './attachments'

function store(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dack-attach-'))
  writeFileSync(join(dir, 'invoice.pdf'), '%PDF-1.4 stub')
  mkdirSync(join(dir, 'sub'))
  return dir
}

test('resolves a stored file by basename', () => {
  const dir = store()
  const r = resolveAttachment(dir, 'invoice.pdf')
  expect('path' in r).toBe(true)
  if ('path' in r) {
    expect(r.name).toBe('invoice.pdf')
    expect(r.path.endsWith('/invoice.pdf')).toBe(true)
  }
})

test('traversal is stripped to a basename → the result NEVER escapes the store', () => {
  const dir = store()
  const realDir = realpathSync(dir)
  for (const evil of ['../../etc/passwd', '../invoice.pdf', 'sub/../../invoice.pdf', '/etc/passwd', 'a/b/c/invoice.pdf']) {
    const r = resolveAttachment(dir, evil)
    // Either it errors (basename wasn't a real store file), or it resolved to an IN-STORE file — but it can
    // NEVER return a path outside the store (basename() reduced any `../` to a bare name). e.g.
    // `../invoice.pdf` → `invoice.pdf` (an in-store file, safe); `../../etc/passwd` → `passwd` (not found).
    if ('path' in r) expect(r.path.startsWith(realDir + '/')).toBe(true)
  }
})

test('a missing file, a directory, `.`/`..`, and absent MEDIA_DIR all error', () => {
  const dir = store()
  expect('error' in resolveAttachment(dir, 'nope.pdf')).toBe(true)
  expect('error' in resolveAttachment(dir, 'sub')).toBe(true) // a directory is not a regular file
  expect('error' in resolveAttachment(dir, '..')).toBe(true)
  expect('error' in resolveAttachment(dir, '.')).toBe(true)
  expect('error' in resolveAttachment(undefined, 'invoice.pdf')).toBe(true)
})

test('a symlink pointing outside the store is rejected', () => {
  const dir = store()
  const outside = mkdtempSync(join(tmpdir(), 'dack-outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'top secret')
  symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'))
  const r = resolveAttachment(dir, 'link.txt')
  expect('error' in r).toBe(true) // realpath escapes the store prefix → rejected
})
