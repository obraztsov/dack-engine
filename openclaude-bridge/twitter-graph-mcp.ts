/**
 * Twitter GRAPH capability — a standalone **stdio MCP server**, sibling of `twitter-read.ts` (content)
 * and `twitter-mcp.ts` (write). It exposes the duck's SOCIAL GRAPH: who follows it, who it follows.
 *
 * Registered `tier: read`, **`trust: self`** (NOT `public` like twitter-read). The justification: every
 * tool here returns ONLY structured user records — `{id, username, name}` — never free-text tweet
 * content that could smuggle an injection. So reading the graph does NOT contaminate the cycle, which
 * lets the SELF-TRUST `twitter-digest` pull "who newly followed me / who I follow" and write it to
 * `memory/` (a `public` read would floor the cycle to Express and block the memory write). The Rust wall
 * still gates every call; the per-server `tools` allowlist holds it to this surface fail-closed. Same
 * `X_BEARER_TOKEN` as the read/write servers + the sensors.
 *
 * stdout is the MCP protocol channel — NEVER log to it; use stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const API = 'https://api.twitter.com/2'

async function xGet(path: string, params: Record<string, string | number>): Promise<any> {
  const token = process.env.X_BEARER_TOKEN
  if (!token) return { ok: false, error: 'X_BEARER_TOKEN not set — no read-secret injected for this route' }
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()
  const r = await fetch(`${API}${path}${qs ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${token}` } })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, status: r.status, error: JSON.stringify(j).slice(0, 400) }
  return { ok: true, ...j }
}

const clampMax = (n: number | undefined, def: number) => Math.min(100, Math.max(5, n ?? def))
const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] })
// The self-trust guarantee lives HERE: graph tools return ONLY these three fields — id + handle + display
// name — and NEVER `description`/bio or tweet `text`, the free-text that carries injection risk.
const trimUser = (u: any) => ({ id: u.id, username: u.username, name: u.name })
// The duck's own account — the default subject for every graph tool (no argument needed).
const own = () => process.env.DACK_HANDLE ?? 'agentdack'

async function resolveUserId(username: string): Promise<{ id?: string; error?: any }> {
  const handle = username.replace(/^@/, '')
  const r = await xGet(`/users/by/username/${encodeURIComponent(handle)}`, {})
  if (!r.ok) return { error: r }
  return { id: r.data?.id } // only the id is read — never the profile's free-text bio
}

const server = new McpServer({ name: 'twitter-graph', version: '0.1.0' })

server.registerTool(
  'get_followers',
  {
    description:
      'Who follows an @username (defaults to YOU, @agentdack) — your own follower list. Returns only ' +
      '{id, username, name} per user (no bio, no tweet text). Diff the usernames against what you recorded ' +
      'last time to spot NEW followers. Read-only, self-trust (safe to use in the digest and write to memory).',
    inputSchema: { username: z.string().optional(), max_results: z.number().int().optional() },
  },
  async ({ username, max_results }: { username?: string; max_results?: number }) => {
    const { id, error } = await resolveUserId(username ?? own())
    if (!id) return asText(error ?? { ok: false, error: 'user not found' })
    const r = await xGet(`/users/${id}/followers`, { max_results: clampMax(max_results, 50), 'user.fields': 'username,name' })
    if (!r.ok) return asText(r)
    return asText({ ok: true, followers: (r.data ?? []).map(trimUser) })
  },
)

server.registerTool(
  'get_following',
  {
    description:
      'Who an @username follows (defaults to YOU, @agentdack) — the accounts you follow. Returns only ' +
      '{id, username, name} per user (no bio, no tweet text). Read-only, self-trust.',
    inputSchema: { username: z.string().optional(), max_results: z.number().int().optional() },
  },
  async ({ username, max_results }: { username?: string; max_results?: number }) => {
    const { id, error } = await resolveUserId(username ?? own())
    if (!id) return asText(error ?? { ok: false, error: 'user not found' })
    const r = await xGet(`/users/${id}/following`, { max_results: clampMax(max_results, 50), 'user.fields': 'username,name' })
    if (!r.ok) return asText(r)
    return asText({ ok: true, following: (r.data ?? []).map(trimUser) })
  },
)

await server.connect(new StdioServerTransport())
console.error('[twitter-graph-mcp] ready')
