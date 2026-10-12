/**
 * `own_replies` — "what have I already said in this thread, and what arrived since?"
 *
 * The duplicate-reply post-mortem (2026-10-11) found that a duck re-answers a thread when its OWN earlier
 * reply is not in front of it: the wake payload carries the ancestor SPINE (root → … → trigger), and the
 * duck's reply is usually a SIBLING branch, so a wake on "⏳ still working, 3 min" sees the peer's questions
 * but not that it answered them two wakes ago. The operator's standing rule is NO output filters — so this
 * is INFORMATION, not a guard: one read-only tool the express step calls before replying in a thread it
 * may already have spoken in. The relay is the system of record (nothing is mirrored here); the model is
 * taught to call it, and decides.
 *
 * Shared by `buzz-cli` (express) and `buzz-read` (perceive). The summary itself is a pure function so it is
 * unit-tested without a relay.
 *
 * Env (harness-injected): BUZZ_SELF_PUBKEY (this duck's hex pubkey), BUZZ_THREAD_ROOT (scope_env ← payload
 * `root`), BUZZ_REPLY_CHANNEL (scope_env ← payload `conversation`). stdout is the MCP channel — log to stderr.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { execBuzz } from './buzz-exec'

export type ThreadEv = { id: string; pubkey: string; content: string; created_at: number; tags?: string[][] }

/** The CLI prints a thread as a bare array, or wrapped under `events` / `messages`. */
export function parseThreadEvents(out: string): ThreadEv[] {
  let j: any
  try {
    j = JSON.parse(out)
  } catch {
    return []
  }
  const evs: any[] = Array.isArray(j) ? j : Array.isArray(j?.events) ? j.events : Array.isArray(j?.messages) ? j.messages : []
  return evs.filter((e) => e && typeof e.id === 'string' && typeof e.pubkey === 'string')
}

const replyTarget = (ev: ThreadEv): string | null => {
  const refs = (ev.tags ?? []).filter((t) => t[0] === 'e')
  return refs.find((t) => t[3] === 'reply')?.[1] ?? refs.find((t) => t[3] === 'root')?.[1] ?? null
}
const iso = (s: number) => new Date(s * 1000).toISOString()
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export type OwnRepliesSummary = {
  thread_root: string
  you_spoke: boolean
  own_count: number
  /** Your most recent replies, oldest → newest. */
  own: { id: string; at: string; reply_to: string | null; content: string }[]
  last_own_at: string | null
  /** What others posted AFTER your last reply — the only thing a new reply could be answering. */
  since_your_last: { count: number; from_others: { id: string; from: string; at: string; content: string }[] }
  hint: string
}

export function ownRepliesSummary(
  evs: ThreadEv[],
  self: string,
  root: string,
  opts: { maxOwn?: number; maxOthers?: number; clipOwn?: number; clipOthers?: number } = {},
): OwnRepliesSummary {
  const { maxOwn = 5, maxOthers = 6, clipOwn = 600, clipOthers = 240 } = opts
  const sorted = [...evs].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
  const mine = sorted.filter((e) => e.pubkey === self)
  const last = mine.length ? mine[mine.length - 1] : null
  const after = last ? sorted.filter((e) => e.pubkey !== self && e.created_at >= last.created_at && e.id !== last.id) : []
  const hint = !last
    ? 'you have not posted in this thread'
    : after.length === 0
      ? 'NOTHING arrived after your last reply — a reply now would repeat yourself; `[]` unless you have something new'
      : `${after.length} message(s) from others since your last reply — answer only what THEY add, not the earlier questions you already covered`
  return {
    thread_root: root,
    you_spoke: mine.length > 0,
    own_count: mine.length,
    own: mine.slice(-maxOwn).map((e) => ({ id: e.id, at: iso(e.created_at), reply_to: replyTarget(e), content: clip(e.content ?? '', clipOwn) })),
    last_own_at: last ? iso(last.created_at) : null,
    since_your_last: {
      count: after.length,
      from_others: after.slice(-maxOthers).map((e) => ({ id: e.id, from: e.pubkey.slice(0, 8), at: iso(e.created_at), content: clip(e.content ?? '', clipOthers) })),
    },
    hint,
  }
}

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] })
const THREAD_MAX_OUT = 8 * 1024 * 1024 // 8MB: digested locally, never returned raw

/** Register the `own_replies` tool on a server. Same code on both Buzz servers so the two cannot drift. */
export function registerOwnRepliesTool(server: McpServer, tag: string): void {
  const SELF = (process.env.BUZZ_SELF_PUBKEY ?? '').trim()
  server.registerTool(
    'own_replies',
    {
      description:
        'What YOU already said in a Buzz thread, and what others posted since — read this BEFORE replying in a ' +
        'thread you may have spoken in (a wake on a progress ping, a follow-up, a resumed thread), so you do not ' +
        'answer the same question twice. Defaults to the thread that woke you; pass `thread_root` (the `root` of a ' +
        'wake, or the id you got when you posted) for another. Returns your last replies, when you last spoke, and ' +
        'the messages from others AFTER that — the only thing a new reply could be answering. Read-only.',
      inputSchema: {
        thread_root: z.string().regex(/^[0-9a-f]{64}$/, 'a 64-hex event id').optional(),
        channel: z.string().min(1).max(200).optional(),
      },
    },
    async ({ thread_root, channel }: { thread_root?: string; channel?: string }) => {
      if (!SELF) return asText({ ok: false, error: 'BUZZ_SELF_PUBKEY not set — cannot tell your posts apart' })
      const root = thread_root || process.env.BUZZ_THREAD_ROOT
      const ch = channel || process.env.BUZZ_REPLY_CHANNEL
      if (!root) return asText({ ok: false, error: 'no thread: this wake carries no thread root, so pass `thread_root`' })
      if (!ch) return asText({ ok: false, error: 'no channel: this wake carries no channel, so pass `channel`' })
      // A busy thread (a worker's progress stream) is far bigger than the 64KB the generic tools cap stdout
      // at — and that cap exists to protect the CONTEXT, which this tool never hands the raw thread to. Day-1
      // live: the research thread overflowed it and the tool failed exactly when it was needed most.
      const r = await execBuzz(['messages', 'thread', '--channel', ch, '--event', root], tag, { maxOut: THREAD_MAX_OUT })
      if (!r.ok) return asText(r)
      const evs = parseThreadEvents(r.out ?? '')
      if (!evs.length) return asText({ ok: false, error: 'thread unreadable or empty (is `channel` the channel this thread lives in?)' })
      const s = ownRepliesSummary(evs, SELF, root)
      console.error(`[${tag}] own_replies root=${root.slice(0, 8)}… own=${s.own_count} since=${s.since_your_last.count}`)
      return asText({ ok: true, ...s })
    },
  )
}
