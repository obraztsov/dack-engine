/**
 * ingress-arm — `arm_thread`: tell the ingress how to read FUTURE replies in a thread.
 *
 * A duck posts a task ("Jarvis, build X — issue 4df1…") and, in the same express step, arms that thread:
 * replies in it should open with the `reply` stance (a critic reading them as a follow-up on the task)
 * and carry `issue:4df1…` as a runlog tag, so the reply cycle can `recall_by_tag` the whole exchange.
 * Without this, a peer's reply lands on the generic org route with no memory of what it answers — which
 * is exactly how threads stalled after one message.
 *
 * Trust, by construction:
 *   - **Never a route.** The webhook path (and so the trust tier) is untouched; only `entry_hint` + `tags`
 *     ride the payload. The harness resolves the hint against the duty's own `entries:` allowlist.
 *   - **The valid hints come from the harness, not the model.** The duty advertises its `entries` keys on
 *     the payload (`entry_hints`); the config maps that to ARM_ENTRIES via `scope_env`, and this tool
 *     exposes EXACTLY those as its schema enum — an invalid hint is unpickable, not merely discouraged.
 *   - **Only a thread you are IN.** Verified against the relay (`messages thread`), not the model's claim:
 *     the duck's own pubkey must appear in the thread (it authored the root, or already replied). You
 *     cannot re-stance a conversation you are not part of.
 *   - TTL (default 7d), bounded sanitized tags.
 *
 * Env: INGRESS_ROUTES_DB (absolute), ARM_ENTRIES (JSON array, via scope_env from `entry_hints`),
 * BUZZ_SELF_PUBKEY, BUZZ_PRIVATE_KEY/BUZZ_RELAY_URL/BUZZ_BIN (for the membership check),
 * BUZZ_REPLY_CHANNEL (default channel = the one that woke us). stdout is the MCP channel — log to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { openRoutesStore, armThread, sanitizeTags } from './ingress-routes'
import { execBuzz } from './buzz-exec'
import { openChannelIndex, resolveOne } from './buzz-channels'

const DB = process.env.INGRESS_ROUTES_DB
const SELF = (process.env.BUZZ_SELF_PUBKEY ?? '').trim()
const DEFAULT_TTL_H = Number(process.env.ARM_TTL_HOURS) || 24 * 7
function parseEntries(): string[] {
  try {
    const v = JSON.parse(process.env.ARM_ENTRIES ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(x)) : []
  } catch {
    return []
  }
}
const ENTRIES = parseEntries()

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] })

/** Is our pubkey a participant of this thread? Checked on the relay, not trusted from the model. */
async function weAreInThread(channel: string, root: string): Promise<{ ok: boolean; why?: string }> {
  if (!SELF) return { ok: false, why: 'BUZZ_SELF_PUBKEY not set — cannot verify thread membership' }
  const r = await execBuzz(['messages', 'thread', '--channel', channel, '--event', root], 'ingress-arm')
  if (!r.ok) return { ok: false, why: `could not read the thread: ${(r.error ?? '').slice(0, 160)}` }
  try {
    const j = JSON.parse(r.out ?? '')
    const evs: any[] = Array.isArray(j) ? j : Array.isArray(j?.events) ? j.events : Array.isArray(j?.messages) ? j.messages : [j]
    const inIt = evs.some((e) => e && e.pubkey === SELF)
    return inIt ? { ok: true } : { ok: false, why: 'you are not a participant in that thread (you neither started it nor replied in it)' }
  } catch {
    return { ok: false, why: 'unreadable thread response' }
  }
}

const server = new McpServer({ name: 'ingress-arm', version: '0.1.0' })

const hintSchema = ENTRIES.length ? z.enum(ENTRIES as [string, ...string[]]) : z.string().max(0)
server.registerTool(
  'arm_thread',
  {
    description:
      (ENTRIES.length
        ? `Tell the ingress how to read FUTURE replies in a Buzz thread you are part of. Pick a stance from: ${ENTRIES.map((e) => `"${e}"`).join(', ')}. `
        : 'This wake offers no stances to arm with (its duty declares no `entries:`). ') +
      'Give `thread_root` (the root event id of the thread — the id returned when you posted the task, or the `root` of your wake) and `tags` ' +
      '(e.g. ["issue:<id>","project:<slug>"]) so every reply in it lands under those runlog tags and opens with that stance. ' +
      'Do this in the SAME step you post a task or brief. Defaults to the channel that woke you.',
    inputSchema: {
      thread_root: z.string().regex(/^[0-9a-f]{64}$/, 'a 64-hex event id'),
      entry_hint: hintSchema,
      tags: z.array(z.string().min(1).max(80)).max(8).default([]),
      channel: z.string().min(1).max(200).optional(),
      ttl_hours: z.number().int().min(1).max(24 * 30).optional(),
    },
  },
  async ({ thread_root, entry_hint, tags, channel, ttl_hours }: { thread_root: string; entry_hint: string; tags: string[]; channel?: string; ttl_hours?: number }) => {
    if (!DB) return asText({ ok: false, error: 'INGRESS_ROUTES_DB not set' })
    if (!ENTRIES.length) return asText({ ok: false, error: 'no stances available on this wake — nothing to arm' })
    const want = channel || process.env.BUZZ_REPLY_CHANNEL
    if (!want) return asText({ ok: false, error: 'no channel: pass `channel` explicitly' })
    const rc = resolveOne(openChannelIndex(DB), want) // a channel NAME or id
    if (!rc.ok) return asText({ ok: false, error: rc.error })
    const ch = rc.id
    const member = await weAreInThread(ch, thread_root)
    if (!member.ok) {
      console.error(`[ingress-arm] REFUSED root=${thread_root.slice(0, 8)} — ${member.why}`)
      return asText({ ok: false, error: member.why })
    }
    const db = openRoutesStore(DB)
    const row = armThread(db, { thread_root, channel: ch, entry_hint, tags: sanitizeTags(tags), armed_by: SELF, ttl_secs: (ttl_hours ?? DEFAULT_TTL_H) * 3600 })
    console.error(`[ingress-arm] armed root=${thread_root.slice(0, 8)} stance=${entry_hint} tags=${row.tags.join(',')} ttl=${ttl_hours ?? DEFAULT_TTL_H}h`)
    return asText({ ok: true, armed: { thread_root, entry_hint, tags: row.tags, expires_at: row.expires_at }, hint: 'replies in this thread now open with that stance and carry those tags' })
  },
)

await server.connect(new StdioServerTransport())
console.error(`[ingress-arm] ready — db=${DB || '(unset)'} self=${SELF.slice(0, 8) || '(unset)'} stances=[${ENTRIES.join(',')}]`)
