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
import { openIngressStore, setChatAttachment, type MediaType } from './ingress-store'

// Per-chat attachment store — the harness injects INGRESS_DB (absolute). Absent ⇒ the toggle is
// unavailable (returns an error); `reply` still works.
const ingressStore = process.env.INGRESS_DB ? openIngressStore(process.env.INGRESS_DB) : null

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
    const body: Record<string, unknown> = { chat_id: chat, text }
    const replyTo = process.env.TELEGRAM_REPLY_TO
    if (replyTo) body.reply_parameters = { message_id: Number(replyTo) }
    return asText(await tgSend(body))
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

await server.connect(new StdioServerTransport())
console.error('[telegram-mcp] ready')
