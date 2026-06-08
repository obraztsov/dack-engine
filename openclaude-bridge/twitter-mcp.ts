/**
 * Twitter capability — a standalone **stdio MCP server** the bridge spawns and the OpenClaude
 * SDK connects to (the in-process `sdk` server type fails to instantiate in this SDK build, so
 * we use the well-supported stdio transport). Exposes `mcp__twitter__post` / `mcp__twitter__reply`
 * to Express; the Rust wall still gates every call via the bridge's `canUseTool`.
 *
 * The bearer is `X_BEARER_TOKEN` (injected by the harness ONLY for routes whose `secrets: [x]`
 * grant it). `DACK_TWITTER_DRY_RUN=1` composes without posting — first-run safety for an
 * irreversible outward action. stdout is the MCP protocol channel: NEVER log to it — use stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

async function xPostTweet(body: Record<string, unknown>): Promise<unknown> {
  const token = process.env.X_BEARER_TOKEN
  if (!token) return { ok: false, error: 'X_BEARER_TOKEN not set — no act-secret was injected for this route' }
  if (process.env.DACK_TWITTER_DRY_RUN === '1') {
    console.error('[twitter-mcp] DRY RUN — would post:', JSON.stringify(body))
    return { ok: true, dry_run: true, would_post: body }
  }
  const r = await fetch('https://api.twitter.com/2/tweets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) return { ok: false, status: r.status, error: JSON.stringify(j).slice(0, 400) }
  console.error('[twitter-mcp] posted id=', j?.data?.id)
  return { ok: true, id: j?.data?.id, text: j?.data?.text }
}

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] })

const server = new McpServer({ name: 'twitter', version: '0.1.0' })

server.registerTool(
  'post',
  {
    description: 'Post a NEW standalone tweet as @agentdack (≤280 chars). Use for your own posts, not replies.',
    inputSchema: { text: z.string().min(1).max(280) },
  },
  async ({ text }: { text: string }) => asText(await xPostTweet({ text })),
)

server.registerTool(
  'reply',
  {
    description:
      'Reply to a tweet (≤280 chars). `in_reply_to_tweet_id` is the source_tweet_id from your baton context.',
    inputSchema: { text: z.string().min(1).max(280), in_reply_to_tweet_id: z.string().min(1) },
  },
  async ({ text, in_reply_to_tweet_id }: { text: string; in_reply_to_tweet_id: string }) =>
    asText(await xPostTweet({ text, reply: { in_reply_to_tweet_id } })),
)

await server.connect(new StdioServerTransport())
console.error('[twitter-mcp] ready')
