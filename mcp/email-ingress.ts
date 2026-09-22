/**
 * email-ingress — the duck's INBOUND bridge for EMAIL. A harness module (sibling of telegram/buzz ingress),
 * but RECEIVE-driven rather than polling: it runs a small HTTP server that a **Cloudflare Email Worker**
 * (deployed on the duck's domain) POSTs each incoming email to. It:
 *   1. AUTHENTICATES the POST with a shared secret (`EMAIL_INGRESS_SECRET`) — so only our Worker can inject
 *      an email, not any random caller that finds the endpoint.
 *   2. STORES each attachment (base64 → the harness media dir) as a confined, sha-named blob, building the
 *      channel-agnostic `attachments:[{file,mime,filename,size,kind}]` (the same shape telegram/buzz emit).
 *   3. Classifies TRUST (operator vs public) by the sender, and POSTs a normalized stimulus to the harness
 *      webhook at a tier-specific path — carrying top-level reply-scope scalars (`email_reply_to` etc.) so a
 *      `reply_email` is destination-locked to the sender by the harness, never the model.
 *
 * The Worker template lives at `mcp/cloudflare/email-worker.js`. All email specifics live here; the Rust core
 * just sees "a localhost webhook fired". Logs to stderr (stdout is not the protocol channel here, but keep it
 * consistent with the other ingress modules).
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, isAbsolute, resolve as resolvePath } from 'node:path'

interface Config {
  harness_webhook: string // e.g. http://127.0.0.1:8799
  listen_port: number // the Worker POSTs here (exposed publicly via the pond proxy / a tunnel)
  op_path: string // harness webhook path for operator/self email (trust seed)
  pub_path: string // …for everyone else (public)
  operator_email: string // sender that maps to `op_path`; everyone else → `pub_path`
  media_dir: string // MUST match the engine media_dir (where the harness resolves + confines attachments)
  max_attachment_bytes: number
  max_attachments: number
}
const DEFAULTS: Config = {
  harness_webhook: 'http://127.0.0.1:8787',
  listen_port: 8899,
  op_path: '/email/op',
  pub_path: '/email/pub',
  operator_email: '',
  media_dir: 'media',
  max_attachment_bytes: 20 * 1024 * 1024,
  max_attachments: 10,
}

function loadConfig(): Config {
  const path = process.env.EMAIL_INGRESS_CONFIG
  let cfg = { ...DEFAULTS }
  if (path && existsSync(path)) {
    try {
      cfg = { ...cfg, ...JSON.parse(readFileSync(path, 'utf8')) }
    } catch (e) {
      log('bad EMAIL_INGRESS_CONFIG json:', e)
    }
  }
  if (!process.env.EMAIL_INGRESS_SECRET) throw new Error('email-ingress: EMAIL_INGRESS_SECRET not in env (shared with the Cloudflare Worker)')
  return cfg
}

const log = (...a: unknown[]) => console.error('[email-ingress]', ...a)
const cfg = loadConfig()
const mediaDirAbs = () => (isAbsolute(cfg.media_dir) ? cfg.media_dir : resolvePath(process.cwd(), cfg.media_dir))

/** Constant-time compare of the Worker's shared-secret header against ours (avoids a timing oracle). */
function secretOk(given: string | null): boolean {
  const want = process.env.EMAIL_INGRESS_SECRET!
  if (!given) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(want).digest()
  return timingSafeEqual(a, b)
}

const EXT_FOR_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'text/plain': '.txt',
  'text/csv': '.csv',
}

type InAttachment = { filename?: string; mime?: string; content?: string /* base64 */ }
type OutAttachment = { file: string; mime: string; filename: string; size: number; kind: 'image' | 'file' }

/** Decode + store one attachment to the media dir, returning the channel-agnostic entry (or null on failure). */
function storeAttachment(dir: string, a: InAttachment): OutAttachment | null {
  if (!a.content) return null
  let buf: Buffer
  try {
    buf = Buffer.from(a.content, 'base64')
  } catch {
    return null
  }
  if (buf.length === 0 || buf.length > cfg.max_attachment_bytes) {
    log('attachment skipped (size', buf.length, ')')
    return null
  }
  const mime = a.mime || 'application/octet-stream'
  const orig = a.filename || 'file'
  const ext = (orig.includes('.') ? '.' + orig.split('.').pop() : EXT_FOR_MIME[mime]) ?? '.bin'
  const sha = createHash('sha256').update(buf).digest('hex').slice(0, 40)
  const file = `email_${sha}${ext.toLowerCase().replace(/[^a-z0-9.]/g, '')}`
  writeFileSync(join(dir, file), buf)
  return { file, mime, filename: orig, size: buf.length, kind: mime.startsWith('image/') ? 'image' : 'file' }
}

async function handleEmail(body: any): Promise<void> {
  const from = String(body.from ?? '').trim()
  const subject = String(body.subject ?? '')
  const text = String(body.text ?? body.body ?? '')
  const messageId = String(body.message_id ?? body.messageId ?? '')
  const dir = mediaDirAbs()
  mkdirSync(dir, { recursive: true })
  const attachments: OutAttachment[] = []
  const media: Array<{ kind: 'image'; file: string; mime: string }> = []
  for (const a of (Array.isArray(body.attachments) ? body.attachments : []).slice(0, cfg.max_attachments)) {
    const stored = storeAttachment(dir, a)
    if (!stored) continue
    // An image attachment ALSO rides the vision lane (the duck sees it); a document is a routable blob only.
    if (stored.kind === 'image') media.push({ kind: 'image', file: stored.file, mime: stored.mime })
    else attachments.push(stored)
  }
  const isOperator = !!cfg.operator_email && from.toLowerCase() === cfg.operator_email.toLowerCase()
  const path = isOperator ? cfg.op_path : cfg.pub_path
  const payload = {
    from,
    subject,
    text,
    message_id: messageId,
    ...(attachments.length ? { attachments } : {}),
    ...(media.length ? { media } : {}),
    // Top-level reply-scope scalars → the harness maps these into the email MCP's env (scope_env), so a
    // `reply_email` is destination-locked to THIS sender. The model never supplies the recipient.
    email_reply_to: from,
    email_subject: subject,
    ...(messageId ? { email_in_reply_to: messageId } : {}),
    // One conversation per sender (coalesce + sticky session), same idea as a telegram chat_id.
    dedup_key: `email:${from.toLowerCase()}`,
  }
  const r = await fetch(cfg.harness_webhook + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  log(`email from ${from} (${attachments.length} doc, ${media.length} img) → ${path} (${r.status})`)
}

function main(): void {
  log(`up — listening :${cfg.listen_port}, webhook ${cfg.harness_webhook}, operator ${cfg.operator_email || '(none)'}`)
  Bun.serve({
    port: cfg.listen_port,
    async fetch(req) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (!secretOk(req.headers.get('x-email-ingress-secret'))) return new Response('unauthorized', { status: 401 })
      let body: any
      try {
        body = await req.json()
      } catch {
        return new Response('bad json', { status: 400 })
      }
      try {
        await handleEmail(body)
      } catch (e) {
        log('handle failed:', e)
        return new Response('error', { status: 500 })
      }
      return new Response('ok', { status: 202 })
    },
  })
}

if (import.meta.main) main()

export { storeAttachment, secretOk }
