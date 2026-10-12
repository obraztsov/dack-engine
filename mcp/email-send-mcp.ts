/**
 * Email EGRESS capability — a standalone **stdio MCP server** the bridge spawns, sibling of `telegram-mcp.ts`.
 * ONE tool, `reply_email{subject?, text, attachment_id?}`, **destination-LOCKED** to the sender that woke
 * this cycle: the email-ingress injects `EMAIL_REPLY_TO` (+ `EMAIL_SUBJECT` / `EMAIL_IN_REPLY_TO`) into this
 * server's env via `scope_env`, so the **model never supplies a recipient** — a prompt-injection ("email
 * legal@…") has no destination argument to hijack. Proactive send to a chosen address is a SEPARATE
 * privileged server (an allow-list, min_trust:org), deferred — mirrors the telegram reply vs send split.
 *
 * Provider-agnostic: a transactional send API via `EMAIL_API_URL` + `EMAIL_API_KEY` (harness-injected secret)
 * with a Resend-shaped JSON body (`{from,to,subject,text,attachments:[{filename,content(base64)}]}`) —
 * swappable to Postmark/SendGrid/MailChannels by URL+key+a body shim. `EMAIL_FROM` is the duck's address
 * (static env). Attachments are named by `attachment_id` and confined to the harness store (shared
 * `resolveAttachment`) — the model attaches only a stored file, never a host path. stdout is the MCP
 * protocol channel — NEVER log to it; use stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { openIngressStore, recordSend } from './ingress-store'
import { resolveSendable } from './attachments'

const ingressStore = process.env.INGRESS_DB ? openIngressStore(process.env.INGRESS_DB) : null
const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] })

/** POST to the configured transactional email API (Resend-shaped). Returns {ok, id?} or {ok:false, error}. */
async function sendEmail(to: string, subject: string, text: string, att?: { path: string; name: string }): Promise<any> {
  const url = process.env.EMAIL_API_URL
  const key = process.env.EMAIL_API_KEY
  const from = process.env.EMAIL_FROM
  if (!url || !key || !from) return { ok: false, error: 'email provider not configured (need EMAIL_API_URL, EMAIL_API_KEY, EMAIL_FROM)' }
  const body: Record<string, unknown> = { from, to, subject, text }
  if (process.env.EMAIL_IN_REPLY_TO) body.headers = { 'In-Reply-To': process.env.EMAIL_IN_REPLY_TO }
  if (att) body.attachments = [{ filename: basename(att.name), content: readFileSync(att.path).toString('base64') }]
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j: any = await r.json().catch(() => ({}))
    if (!r.ok) return { ok: false, status: r.status, error: JSON.stringify(j).slice(0, 400) }
    console.error('[email-mcp] sent to', to, 'id=', j?.id ?? j?.MessageID ?? '?')
    return { ok: true, id: j?.id ?? j?.MessageID ?? null }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

const server = new McpServer({ name: 'email', version: '0.1.0' })

server.registerTool(
  'reply_email',
  {
    description:
      'Reply by EMAIL to the person who emailed you (the sender that woke this cycle). Optional subject ' +
      '(defaults to Re: their subject) and an optional file: `attachment_id` names a file in your attachment ' +
      'store (e.g. a prepared invoice) — you cannot attach an arbitrary path. The recipient is fixed by the ' +
      'harness; you provide only the content.',
    inputSchema: {
      subject: z.string().max(200).optional(),
      text: z.string().min(1).max(20000),
      attachment_id: z.string().max(256).optional(), // legacy alias of `path`
      path: z.string().max(512).optional(), // a file in your WORKSPACE (inbox/…, outbox/…, repos/…)
    },
  },
  async ({ subject, text, attachment_id, path }: { subject?: string; text: string; attachment_id?: string; path?: string }) => {
    const attachment_ref = path || attachment_id
    const to = process.env.EMAIL_REPLY_TO
    if (!to) return asText({ ok: false, error: 'no source email in scope — this cycle was not woken by an email' })
    const subj = subject ?? (process.env.EMAIL_SUBJECT ? `Re: ${process.env.EMAIL_SUBJECT}` : '(no subject)')
    let att: { path: string; name: string } | undefined
    if (attachment_ref) {
      const r = resolveSendable(process.env.WORKSPACE_DIR, process.env.MEDIA_DIR, attachment_ref)
      if ('error' in r) return asText({ ok: false, error: r.error })
      att = r
    }
    const at = Math.floor(Date.now() / 1000)
    const sent: any = await sendEmail(to, subj, text, att)
    if (!sent?.ok) console.error(`[email-mcp] send FAILED to=${to}: ${sent?.error ?? 'unknown'}`)
    if (ingressStore)
      recordSend(
        ingressStore,
        { via: att ? 'reply_email+file' : 'reply_email', chatId: to, ok: !!sent?.ok, messageId: null, chars: text.length, error: sent?.ok ? null : (sent?.error ?? 'unknown') },
        at,
      )
    return asText(sent)
  },
)

await server.connect(new StdioServerTransport())
