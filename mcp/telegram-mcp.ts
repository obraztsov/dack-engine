/**
 * Telegram EGRESS capability — a standalone **stdio MCP server** the bridge spawns, sibling of
 * `twitter-mcp.ts`. ONE tool, `reply{text}`, and it is **destination-LOCKED**: it sends only to the
 * chat that woke this cycle. The harness injects that chat into this server's env at assembly
 * (`TELEGRAM_REPLY_CHAT` / `TELEGRAM_REPLY_TO`, via `scope_env`), so the **model never supplies a
 * chat_id** — a prompt-injection ("post to the org group", "DM @victim") has no destination argument
 * to hijack. The duck can chat in its own thread (any tier, the trencher); it physically cannot reach
 * another chat. Sending to an arbitrary/protected chat is a SEPARATE privileged server (min_trust:org),
 * deferred.
 *
 * The bot token is `TELEGRAM_BOT_TOKEN` (harness-injected into env, never the agent context). Raw Bot
 * API `fetch`. stdout is the MCP protocol channel — NEVER log to it; use stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { openIngressStore, setChatAttachment, getReferral, recordSend, type MediaType } from './ingress-store'
import { openPondStore, restoreHandles, spliceHandles } from './pond-store'
import { resolveSendable } from './attachments'

// Per-chat attachment store — the harness injects INGRESS_DB (absolute). Absent ⇒ the toggle is
// unavailable (returns an error); `reply` still works.
const ingressStore = process.env.INGRESS_DB ? openIngressStore(process.env.INGRESS_DB) : null
// Pond secret-handle store (same file, own tables) — the resolve+splice side of the envelope
// (PRD §6.6): `H-…` tokens in outgoing text become their stored values ONLY when this chat is the
// handle's owner. Both sides of that equality are harness-injected; the model influences neither.
const pondStore = process.env.INGRESS_DB ? openPondStore(process.env.INGRESS_DB) : null

async function tgSend(body: Record<string, unknown>): Promise<unknown> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok || j?.ok === false) return { ok: false, status: r.status, error: JSON.stringify(j).slice(0, 400) }
  console.error('[telegram-mcp] replied message_id=', j?.result?.message_id, 'to', j?.result?.chat?.id)
  return { ok: true, message_id: j?.result?.message_id, chat_id: j?.result?.chat?.id }
}

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] })

// Send a stored file to a chat via Bot API `sendDocument` (multipart). Bytes never touched the model —
// the harness stored them, the model only named the id.
async function tgSendDocument(chat: string, filePath: string, fileName: string, caption: string | undefined, replyTo: string | undefined): Promise<any> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' }
  const form = new FormData()
  form.append('chat_id', chat)
  form.append('document', new Blob([readFileSync(filePath)]), fileName)
  if (caption) form.append('caption', caption.slice(0, 1024))
  if (replyTo) form.append('reply_parameters', JSON.stringify({ message_id: Number(replyTo) }))
  const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok || j?.ok === false) return { ok: false, status: r.status, error: JSON.stringify(j).slice(0, 400) }
  console.error('[telegram-mcp] sent document', fileName, 'message_id=', j?.result?.message_id, 'to', j?.result?.chat?.id)
  return { ok: true, message_id: j?.result?.message_id, chat_id: j?.result?.chat?.id }
}

const server = new McpServer({ name: 'telegram', version: '0.2.0' })

server.registerTool(
  'reply',
  {
    description:
      'Reply in the Telegram chat that woke you (≤4096 chars). The destination is fixed by the harness to the chat you are talking in — you provide only the text; you cannot send anywhere else.',
    inputSchema: { text: z.string().min(1).max(4096) },
  },
  async ({ text }: { text: string }) => {
    const chat = process.env.TELEGRAM_REPLY_CHAT
    if (!chat) return asText({ ok: false, error: 'no source chat in scope — this cycle was not woken by Telegram' })
    // Envelope splice: resolve any pond secret-handles (`H-…`) against THIS chat. All-or-nothing —
    // a handle that isn't this chat's (wrong owner, expired, already used) refuses the whole send,
    // consuming nothing. The tool result NEVER carries the spliced value, only the count.
    let out = text
    let consumed: string[] = []
    const at = Math.floor(Date.now() / 1000)
    if (pondStore) {
      const s = spliceHandles(pondStore, text, chat, at)
      if (!s.ok) {
        console.error(`[telegram-mcp] splice refused handle=${s.handle} reason=${s.reason}`)
        // The user perceives an undelivered reply — audit it as a failed attempt.
        if (ingressStore)
          recordSend(ingressStore, { via: 'reply', chatId: chat, ok: false, chars: text.length, error: `splice_refused:${s.reason}` }, at)
        return asText({
          ok: false,
          error:
            `cannot deliver ${s.handle}: ${s.reason.replace('_', ' ')} — mint a fresh one ` +
            `(e.g. enter_configurator again) and resend`,
        })
      }
      out = s.text
      consumed = s.handles
    }
    const body: Record<string, unknown> = { chat_id: chat, text: out }
    const replyTo = process.env.TELEGRAM_REPLY_TO
    if (replyTo) body.reply_parameters = { message_id: Number(replyTo) }
    // Forum topics: land the reply in the SAME topic the message came from (harness-injected via scope_env,
    // like the chat/reply ids). Absent/`null` on a non-forum chat → omitted (sends to the chat as before).
    const thread = process.env.TELEGRAM_REPLY_THREAD
    if (thread && thread !== 'null') body.message_thread_id = Number(thread)
    const sent: any = await tgSend(body)
    if (!sent?.ok && consumed.length && pondStore) {
      // Delivery itself failed — the value reached no one; make the same handles work on retry.
      restoreHandles(pondStore, consumed, at)
      console.error(`[telegram-mcp] send failed, restored ${consumed.length} handle(s)`)
    }
    if (!sent?.ok) console.error(`[telegram-mcp] send FAILED chat=${chat}: ${sent?.error ?? 'unknown'}`)
    // Durable delivery ground truth (stderr is swallowed by the SDK; the runlog under-records).
    if (ingressStore)
      recordSend(
        ingressStore,
        { via: 'reply', chatId: chat, ok: !!sent?.ok, messageId: sent?.message_id ?? null, replyTo: replyTo ?? null, chars: out.length, error: sent?.ok ? null : (sent?.error ?? 'unknown') },
        at,
      )
    return asText(consumed.length && sent?.ok ? { ...sent, spliced: consumed.length } : sent)
  },
)

server.registerTool(
  'reply_document',
  {
    description:
      'Send a FILE from your WORKSPACE to the Telegram chat that woke you — a document you received (`inbox/…`, ' +
      'the `file` of an `attachments` entry), one you wrote (`outbox/report.md`), or a file in a cloned repo. ' +
      '`path` is relative to your workspace; an arbitrary host path is refused. Optional short caption. The ' +
      'destination is fixed to your chat, same as reply.',
    inputSchema: { path: z.string().min(1).max(512).optional(), attachment_id: z.string().min(1).max(256).optional(), caption: z.string().max(1024).optional() },
  },
  async ({ path, attachment_id, caption }: { path?: string; attachment_id?: string; caption?: string }) => {
    const chat = process.env.TELEGRAM_REPLY_CHAT
    if (!chat) return asText({ ok: false, error: 'no source chat in scope — this cycle was not woken by Telegram' })
    const ref = path || attachment_id
    if (!ref) return asText({ ok: false, error: 'give `path` (relative to your workspace)' })
    const res = resolveSendable(process.env.WORKSPACE_DIR, process.env.MEDIA_DIR, ref)
    if ('error' in res) return asText({ ok: false, error: res.error })
    const replyTo = process.env.TELEGRAM_REPLY_TO
    const at = Math.floor(Date.now() / 1000)
    const sent: any = await tgSendDocument(chat, res.path, res.name, caption, replyTo)
    if (!sent?.ok) console.error(`[telegram-mcp] sendDocument FAILED chat=${chat}: ${sent?.error ?? 'unknown'}`)
    if (ingressStore)
      recordSend(
        ingressStore,
        { via: 'reply_document', chatId: chat, ok: !!sent?.ok, messageId: sent?.message_id ?? null, replyTo: replyTo ?? null, chars: 0, error: sent?.ok ? null : (sent?.error ?? 'unknown') },
        at,
      )
    return asText(sent)
  },
)

server.registerTool(
  'set_chat_attachments',
  {
    description:
      'Enable or disable attachments FOR THE CHAT YOU ARE TALKING IN. The destination is fixed by the ' +
      'harness to the chat that woke you — you provide only the flag, you cannot toggle anywhere else. ' +
      '`media` picks which kind: "image" (screenshots/photos), "voice" (voice notes → transcribed), or ' +
      '"all" (default, both). Turn ON when a client should send you that media; OFF to stop processing it.',
    inputSchema: { allowed: z.boolean(), media: z.enum(['image', 'voice', 'all']).optional() },
  },
  async ({ allowed, media }: { allowed: boolean; media?: 'image' | 'voice' | 'all' }) => {
    const chat = process.env.TELEGRAM_REPLY_CHAT
    if (!chat) return asText({ ok: false, error: 'no source chat in scope — this cycle was not woken by Telegram' })
    if (!ingressStore) return asText({ ok: false, error: 'INGRESS_DB not set — attachment store unavailable' })
    const types: MediaType[] = media === 'image' ? ['image'] : media === 'voice' ? ['voice'] : ['image', 'voice']
    for (const t of types) setChatAttachment(ingressStore, chat, t, allowed)
    console.error(`[telegram-mcp] set_chat_attachments chat=${chat} media=${media ?? 'all'} allowed=${allowed}`)
    return asText({ ok: true, chat_id: chat, media: media ?? 'all', allowed })
  },
)

server.registerTool(
  'get_referral',
  {
    description:
      'Look up the deep-link referral for the person in THIS chat — the `param` from the ' +
      '`t.me/<bot>?start=<param>` link they opened you with (e.g. a referrer @username or ref code), if ' +
      'any. Scope is fixed by the harness to the chat that woke you; no arguments. Returns {found:false} ' +
      'if they did not arrive via a referral link. Use to confirm/re-apply a referral (e.g. if a first ' +
      'attempt to reward it failed).',
    inputSchema: {},
  },
  async () => {
    const chat = process.env.TELEGRAM_REPLY_CHAT
    if (!chat) return asText({ ok: false, error: 'no source chat in scope — this cycle was not woken by Telegram' })
    if (!ingressStore) return asText({ ok: false, error: 'INGRESS_DB not set — referral store unavailable' })
    // A private chat's chat_id equals the user_id, so the source chat IS the referee key.
    const ref = getReferral(ingressStore, chat)
    return asText(ref ? { ok: true, found: true, referral: ref } : { ok: true, found: false })
  },
)

await server.connect(new StdioServerTransport())
console.error('[telegram-mcp] ready')
