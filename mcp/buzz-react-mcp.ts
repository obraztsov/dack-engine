/**
 * buzz-react — emoji reactions on Buzz messages: `react`, `unreact`, `reactions`.
 *
 * The lightest outward act there is, and the one a teammate uses most: "seen", "on it", "done", "agreed"
 * without a paragraph. Registered `tier: read` + `trust: self` so it is reachable from PERCEIVE — the
 * operator's call (2026-10-13): a looper that acknowledges with 👀 and returns `[]` instead of writing a
 * reply with nothing in it is the point. By construction:
 *   - a reaction is ONE emoji (validated), on a 64-hex event id — defaults to the message that woke you;
 *   - it never spends the one-outward-act budget (not a post), never changes trust (self);
 *   - idempotent against the shared reactions store: reacting twice with the same emoji is a no-op;
 *   - `unreact` removes only YOUR reaction; `reactions` lists what is on a message (relay truth).
 * Env: BUZZ_PRIVATE_KEY (injected), BUZZ_RELAY_URL, BUZZ_BIN, BUZZ_SELF_PUBKEY, INGRESS_ROUTES_DB,
 * BUZZ_REPLY_TO (scope_env ← payload `in_reply_to`), BUZZ_REPLY_CHANNEL (← `conversation`).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execBuzz } from './buzz-exec'
import { openRoutesStore, upsertReactions, deleteReaction, reactionsFor, summarizeReactions } from './ingress-routes'
import { validateEmoji, EVENT_ID_RE, parseReactionsOut } from './buzz-react'

const DB = process.env.INGRESS_ROUTES_DB
const SELF = (process.env.BUZZ_SELF_PUBKEY ?? '').trim()
const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] })
const store = DB ? openRoutesStore(DB) : null
const label = (p: string) => (p === SELF ? 'you' : p.slice(0, 8))

const server = new McpServer({ name: 'buzz-react', version: '0.1.0' })

server.registerTool(
  'react',
  {
    description:
      'React to a Buzz message with ONE emoji — the teammate\'s acknowledgement that needs no words: 👀 "seen / on it", ' +
      '👍 "noted, nothing to add", ✅ "done / agreed", 🙏 "thanks". Defaults to the message that woke you; pass `event` ' +
      '(64-hex id) for another message in the thread. Reacting is NOT a reply and does not spend your one outward act — ' +
      'use it instead of a reply when the sender only needs to know you saw it, and alongside nothing (`[]`) when nothing is owed. ' +
      'Idempotent: the same emoji twice is a no-op.',
    inputSchema: {
      emoji: z.string().min(1).max(40),
      event: z.string().regex(EVENT_ID_RE, 'a 64-hex event id').optional(),
    },
  },
  async ({ emoji: raw, event }: { emoji: string; event?: string }) => {
    const v = validateEmoji(raw)
    if (!v.ok) return asText({ ok: false, error: v.error })
    const target = event || process.env.BUZZ_REPLY_TO
    if (!target || !EVENT_ID_RE.test(target)) return asText({ ok: false, error: 'no target: this wake carries no message id, so pass `event` (64-hex)' })
    if (store && SELF && reactionsFor(store, target).some((r) => r.pubkey === SELF && r.emoji === v.emoji)) {
      return asText({ ok: true, already: true, event: target, emoji: v.emoji, hint: 'you already reacted with this emoji — nothing sent' })
    }
    const r = await execBuzz(['reactions', 'add', '--event', target, '--emoji', v.emoji], 'buzz-react')
    if (!r.ok) return asText({ ok: false, error: (r.error ?? 'reactions add failed').slice(0, 300) })
    let id: string | null = null
    try {
      const j = JSON.parse(r.out ?? '')
      id = typeof j?.id === 'string' ? j.id : typeof j?.event_id === 'string' ? j.event_id : null
    } catch {
      /* the relay's ack shape is not load-bearing */
    }
    if (store && SELF) {
      upsertReactions(store, [{ event_id: id ?? `local:${target}:${SELF}:${v.emoji}`, target_id: target, channel: process.env.BUZZ_REPLY_CHANNEL ?? '', pubkey: SELF, emoji: v.emoji, created_at: Math.floor(Date.now() / 1000) }])
    }
    console.error(`[buzz-react] ${v.emoji} on ${target.slice(0, 8)}…`)
    return asText({ ok: true, event: target, emoji: v.emoji, reaction_id: id })
  },
)

server.registerTool(
  'unreact',
  {
    description: 'Remove YOUR reaction (one emoji) from a Buzz message. Defaults to the message that woke you.',
    inputSchema: {
      emoji: z.string().min(1).max(40),
      event: z.string().regex(EVENT_ID_RE, 'a 64-hex event id').optional(),
    },
  },
  async ({ emoji: raw, event }: { emoji: string; event?: string }) => {
    const v = validateEmoji(raw)
    if (!v.ok) return asText({ ok: false, error: v.error })
    const target = event || process.env.BUZZ_REPLY_TO
    if (!target || !EVENT_ID_RE.test(target)) return asText({ ok: false, error: 'no target: pass `event` (64-hex)' })
    const r = await execBuzz(['reactions', 'remove', '--event', target, '--emoji', v.emoji], 'buzz-react')
    if (!r.ok) return asText({ ok: false, error: (r.error ?? 'reactions remove failed').slice(0, 300) })
    if (store && SELF) deleteReaction(store, target, SELF, v.emoji)
    return asText({ ok: true, event: target, emoji: v.emoji, removed: true })
  },
)

server.registerTool(
  'reactions',
  {
    description:
      'List the reactions on a Buzz message (relay truth): per emoji, who reacted — "you" marks your own. Defaults to the ' +
      'message that woke you. A 👀 from a worker on your task post means acknowledged; do not ping them for it.',
    inputSchema: { event: z.string().regex(EVENT_ID_RE, 'a 64-hex event id').optional() },
  },
  async ({ event }: { event?: string }) => {
    const target = event || process.env.BUZZ_REPLY_TO
    if (!target || !EVENT_ID_RE.test(target)) return asText({ ok: false, error: 'no target: pass `event` (64-hex)' })
    const r = await execBuzz(['reactions', 'get', '--event', target], 'buzz-react')
    if (!r.ok) return asText({ ok: false, error: (r.error ?? 'reactions get failed').slice(0, 300) })
    const rows = parseReactionsOut(r.out ?? '')
    if (store) {
      upsertReactions(
        store,
        rows.map((x) => ({ event_id: x.id ?? `relay:${target}:${x.pubkey}:${x.emoji}`, target_id: target, channel: process.env.BUZZ_REPLY_CHANNEL ?? '', pubkey: x.pubkey, emoji: x.emoji, created_at: x.created_at })),
      )
    }
    const summary = summarizeReactions(
      rows.map((x, i) => ({ event_id: x.id ?? String(i), target_id: target, channel: '', pubkey: x.pubkey, emoji: x.emoji, created_at: x.created_at })),
      label,
    )
    return asText({ ok: true, event: target, reactions: summary, total: rows.length })
  },
)

await server.connect(new StdioServerTransport())
console.error(`[buzz-react] ready — self=${SELF.slice(0, 8) || '(unset)'} db=${DB || '(unset)'} default_target=${(process.env.BUZZ_REPLY_TO ?? '').slice(0, 8) || '(none)'}`)
