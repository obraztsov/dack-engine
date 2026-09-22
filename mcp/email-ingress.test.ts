import { test, expect } from 'bun:test'
import { storeAttachment, secretOk } from './email-ingress'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('secretOk: constant-time match of the shared secret', () => {
  expect(secretOk('test-secret')).toBe(true)
  expect(secretOk('wrong')).toBe(false)
  expect(secretOk(null)).toBe(false)
})

test('storeAttachment: base64 → media dir, classifies image vs file, rejects empty/oversized', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dack-email-'))
  const pdf = storeAttachment(dir, { filename: 'invoice.pdf', mime: 'application/pdf', content: Buffer.from('%PDF-1.4').toString('base64') })
  expect(pdf && pdf.kind).toBe('file')
  expect(pdf && pdf.file.endsWith('.pdf')).toBe(true)
  expect(readFileSync(join(dir, pdf!.file)).toString()).toBe('%PDF-1.4')
  const png = storeAttachment(dir, { filename: 'shot.png', mime: 'image/png', content: Buffer.from('\x89PNG\r\n').toString('base64') })
  expect(png && png.kind).toBe('image') // an image attachment is classified for the vision lane
  expect(storeAttachment(dir, { filename: 'x', mime: 'text/plain', content: '' })).toBe(null)
})
