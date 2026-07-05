/**
 * SELF-RECALL MCP (`recall-self`, `trust: self`) — the duck's OWN post-firebreak memory: its `thought`
 * + what it `sent` + tags + origin trust, NEVER the raw untrusted `incoming`. Because it can't surface
 * untrusted text, reading it does NOT lower the cycle's trust — so a `self`-cron (the digest) can mine
 * activity and still write `memory/`. SQLite-backed (v0.2.0); the trust boundary is enforced by only
 * ever projecting `thought`/`sent` and scoping FTS to `{thought,sent}`.
 *
 * stdout is the MCP channel — never log to it; use stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  atLeastTrust,
  byTag,
  clamp,
  cursorPage,
  openDb,
  readEntry,
  recentActivity,
  relatedTags,
  renderEntryFull,
  renderThoughtLog,
  search,
  tagNotes,
} from './db'

const db = openDb()
const TAG = process.env.RECALL_TAG // the current conversation, injected per cycle
const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] })
const server = new McpServer({ name: 'recall-self', version: '0.2.0' })

server.registerTool(
  'recent_activity',
  {
    description:
      'Your OWN recent reasoning + replies across ALL chats (default last 2 days), newest last — your ' +
      'thoughts and what you said, each tagged with run_id + chat + origin trust. NEVER the raw incoming ' +
      "text, so reading it keeps you clean (self-trust). Long fields are TRUNCATED with a `[+N chars — " +
      'read_entry …]` marker. Pages NEWEST first: omit `cursor` for the latest, then pass back ' +
      "`page.cursor` for older. `min_trust` (self|org|public) floors out lower-trust chats.",
    inputSchema: {
      days: z.number().int().optional(),
      min_trust: z.string().optional(),
      limit: z.number().int().optional(),
      cursor: z.string().optional(),
    },
  },
  async ({ days, min_trust, limit, cursor }) => {
    const d = clamp(days, 2, 30)
    const rows = atLeastTrust(recentActivity(db, d), min_trust)
    const page = cursorPage(rows, clamp(limit, 25, 50), cursor)
    return asText({ ok: true, days: d, page: { total: page.total, returned: page.returned, has_more: page.has_more, cursor: page.cursor }, log: renderThoughtLog(page.items) })
  },
)

server.registerTool(
  'recall_self_by_tag',
  {
    description:
      'Your OWN thoughts + replies in ONE chat/topic by its tag (find tags via `related_tags` or the ' +
      'environment block). Thoughts-only (no raw incoming) — stays self-trust. Pages newest first.',
    inputSchema: {
      tag: z.string().min(1),
      min_trust: z.string().optional(),
      limit: z.number().int().optional(),
      cursor: z.string().optional(),
    },
  },
  async ({ tag, min_trust, limit, cursor }) => {
    const rows = atLeastTrust(byTag(db, tag).filter((r) => r.thought || r.sent.length), min_trust)
    const page = cursorPage(rows, clamp(limit, 25, 50), cursor)
    return asText({ ok: true, tag, page: { total: page.total, returned: page.returned, has_more: page.has_more, cursor: page.cursor }, log: renderThoughtLog(page.items) })
  },
)

server.registerTool(
  'search_self',
  {
    description:
      'Full-text search your OWN reasoning + replies (thought + sent) for a keyword/phrase — FTS5, ' +
      'ranked. NEVER searches the raw incoming (use the public `recall` server for that). Returns each ' +
      "hit's run_id + chat + time + a highlighted snippet; drill in with `read_entry` / `recall_self_by_tag`.",
    inputSchema: { query: z.string().min(1), limit: z.number().int().optional() },
  },
  async ({ query, limit }) => asText({ ok: true, query, hits: search(db, query, ['thought', 'sent'], clamp(limit, 20, 100)) }),
)

server.registerTool(
  'read_entry',
  {
    description:
      'Read ONE of your entries IN FULL by run_id (the bracketed id in a `[+N chars]` truncation marker). ' +
      'Your full thought + what you sent for that cycle — NEVER the raw incoming, so it stays self-trust.',
    inputSchema: { run_id: z.string().min(1) },
  },
  async ({ run_id }) => {
    const e = readEntry(db, run_id)
    if (!e) return asText({ ok: false, error: `entry "${run_id}" not found` })
    return asText({ ok: true, run_id, entry: renderEntryFull(e, false) })
  },
)

server.registerTool(
  'read_tag_notes',
  {
    description:
      'Read your typed tag-notes — the "sticky notes" you leave for yourself. `kind`: `memory` (operating ' +
      'memory, per chat) or `digest` (pending items for a digest job); omit for both. `tag` reads one ' +
      "chat/topic; `include_expired: true` also shows already-delivered digest notes; `min_trust` floors " +
      'by subject trust. Newest first, each with its kind + trust + when + delivered flag.',
    inputSchema: {
      kind: z.enum(['memory', 'digest']).optional(),
      tag: z.string().optional(),
      include_expired: z.boolean().optional(),
      min_trust: z.string().optional(),
    },
  },
  async ({ kind, tag, include_expired, min_trust }) =>
    asText({ ok: true, notes: tagNotes(db, { kind, tag, includeExpired: include_expired, minTrust: min_trust }) }),
)

server.registerTool(
  'related_tags',
  {
    description:
      'Tag-intersection: the other tags/topics that came up in the same cycles as `tag` — "what else is ' +
      'in this conversation\'s orbit", most-frequent first. Use it to widen from one chat into the topics ' +
      'it touched, then pull them with `recall_self_by_tag`.',
    inputSchema: { tag: z.string().min(1), limit: z.number().int().optional() },
  },
  async ({ tag, limit }) => asText({ ok: true, tag, related: relatedTags(db, tag, clamp(limit, 15, 50)) }),
)

await server.connect(new StdioServerTransport())
console.error(`[recall-self] ready (db=${process.env.RUNLOG_DB ?? 'runlogs.sqlite'}, tag=${TAG ?? '-'})`)
