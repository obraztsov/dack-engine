/**
 * Runlog SELF-RECALL capability — a `trust: self` sibling of `runlog-recall-mcp.ts`. It returns ONLY the
 * duck's OWN post-firebreak output: its `thought`, what it `sent`, the conversation tags, and each entry's
 * ORIGIN TRUST — and it NEVER renders the raw untrusted `incoming`. Because the firebreak doctrine treats
 * the duck's digested thought (not the raw payload) as the trust boundary, reading this server does NOT
 * lower the cycle's trust — so a `self`-trust cron (the activity-digest) can mine recent chat activity and
 * still write `memory/` at self-trust.
 *
 * Contrast with the raw `recall` server (`trust: public`): that one renders verbatim incoming text, so
 * reading it taints the cycle to public. Both are granted at the perceive tier — the model CHOOSES the
 * verbatim transcript (and accepts the public taint) vs this clean thoughts-only view.
 *
 * stdout is the MCP protocol channel — NEVER log to it; use stderr. Pure logic lives in `runlog-recall.ts`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  atLeastTrust,
  clamp,
  listRecentTags,
  loadEntries,
  readTagNotes,
  recentActivity,
  recentDates,
  renderThoughtLog,
} from './runlog-recall'

const RUNLOG_DIR =
  process.env.RECALL_DIR ??
  (process.env.DACK_BRIDGE_CWD ? `${process.env.DACK_BRIDGE_CWD}/runlogs` : 'runlogs')
const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] })

const server = new McpServer({ name: 'recall-self', version: '0.1.0' })

server.registerTool(
  'recent_activity',
  {
    description:
      "Your OWN recent reasoning + replies across ALL your chats (default last 2 days), newest last — your " +
      "thoughts and what you said, each tagged with the chat + its origin trust. NEVER the raw incoming " +
      "text, so reading it keeps you clean (self-trust). Use it to take stock of what's been happening. " +
      '`min_trust` (self|org|public) floors out lower-trust chats (e.g. set `org` to ignore strangers).',
    inputSchema: { days: z.number().int().optional(), min_trust: z.string().optional() },
  },
  async ({ days, min_trust }: { days?: number; min_trust?: string }) => {
    const entries = recentActivity(RUNLOG_DIR, clamp(days, 2, 30), min_trust)
    return asText({ ok: true, days: clamp(days, 2, 30), min_trust: min_trust ?? null, count: entries.length, log: renderThoughtLog(entries) })
  },
)

server.registerTool(
  'recall_self_by_tag',
  {
    description:
      'Your OWN thoughts + replies in ONE chat/topic by its tag (find tags with `list_recent_tags`), over ' +
      'the recent window. Thoughts-only (no raw incoming) — stays self-trust. `min_trust` optional floor.',
    inputSchema: { tag: z.string().min(1), days: z.number().int().optional(), min_trust: z.string().optional() },
  },
  async ({ tag, days, min_trust }: { tag: string; days?: number; min_trust?: string }) => {
    const all = loadEntries(RUNLOG_DIR, recentDates(RUNLOG_DIR, clamp(days, 7, 30)))
    const entries = atLeastTrust(all.filter((e) => e.tags.includes(tag) && (e.thought || e.sent.length)), min_trust)
    return asText({ ok: true, tag, count: entries.length, log: renderThoughtLog(entries) })
  },
)

server.registerTool(
  'list_recent_tags',
  {
    description:
      'List your recent conversation tags (default last 7 days), newest first, with a who-was-here hint — ' +
      'metadata only (no message content), to find a tag for `recall_self_by_tag`.',
    inputSchema: { days: z.number().int().optional(), limit: z.number().int().optional() },
  },
  async ({ days, limit }: { days?: number; limit?: number }) => {
    const entries = loadEntries(RUNLOG_DIR, recentDates(RUNLOG_DIR, clamp(days, 7, 60)))
    return asText({ ok: true, tags: listRecentTags(entries, clamp(limit, 20, 100)) })
  },
)

server.registerTool(
  'read_tag_notes',
  {
    description:
      'Read your tag-notes catalogue — the latest "sticky note" per conversation (who they are, open ' +
      'threads, what to remember), newest first, each with its subject trust + when. This is your quick ' +
      "orientation on a chat before you reply, and the digest's working set. `tag` reads one chat; " +
      '`min_trust` (self|org|public) floors out lower-trust subjects.',
    inputSchema: { tag: z.string().optional(), min_trust: z.string().optional() },
  },
  async ({ tag, min_trust }: { tag?: string; min_trust?: string }) => {
    return asText({ ok: true, notes: readTagNotes(RUNLOG_DIR, { tag, minTrust: min_trust }) })
  },
)

await server.connect(new StdioServerTransport())
const ready_n = (() => { try { return recentActivity(RUNLOG_DIR, 2).length } catch { return -1 } })()
console.error(`[recall-self-mcp] ready (dir=${RUNLOG_DIR}, ${ready_n} recent entries)`)
