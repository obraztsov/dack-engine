/**
 * notify — the agent's path to the operational NOTIFY LANE (error/alert/info reporting with a durable,
 * separate trail). This is deliberately NOT a messaging tool: replying to a client, or pinging a group /
 * another agent, is a normal SEND (a reply/send baton — you can fan out several). `notify` is the separate
 * lane for reporting something OPERATIONAL going wrong (an error you hit, an anomaly a human should know
 * about, an info note) — delivered to the operator's configured notify targets (telegram/buzz/log),
 * connector-agnostic. The model chooses only severity + text; DESTINATIONS are operator config, so there
 * is nothing to hijack (safe from any cycle). Durable-first: appends a local jsonl so a down router loses
 * nothing. stdout is the MCP protocol channel — NEVER log to it; use stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { appendFileSync } from 'node:fs'
import { z } from 'zod'

const ROUTER = process.env.NOTIFY_URL ?? 'http://127.0.0.1:8794/notify'
const LOG = process.env.NOTIFY_MCP_LOG ?? 'notify-mcp.jsonl'
const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] })

const server = new McpServer({ name: 'notify', version: '0.1.0' })

server.registerTool(
  'notify',
  {
    description:
      'Report an OPERATIONAL event to the notify lane: `error` (something failed and you could not recover), ' +
      '`alert` (something is wrong and a human should look — default), or `info` (a briefing/heads-up). This is ' +
      'a separate error/audit TRAIL, NOT a message to anyone — to answer a client or ping a group, use a normal ' +
      'reply/send baton instead. Give one clear `message` (+ optional short `title`). Destinations are operator ' +
      'config; you choose only the severity and text.',
    inputSchema: {
      severity: z.enum(['error', 'alert', 'info']).optional(),
      title: z.string().max(120).optional(),
      message: z.string().min(1).max(2000),
    },
  },
  async ({ severity, title, message }: { severity?: string; title?: string; message: string }) => {
    const sev = severity ?? 'alert'
    const n = {
      severity: sev,
      source: 'agent',
      title: title ?? `duck ${sev}`,
      body: message,
      source_chat: process.env.NOTIFY_SOURCE_CHAT ?? null,
      at: Math.floor(Date.now() / 1000),
    }
    // Durable first — the jsonl survives a down router (and is the audit trail).
    try {
      appendFileSync(LOG, JSON.stringify(n) + '\n')
    } catch (e) {
      console.error('[notify-mcp] log append failed:', e)
    }
    try {
      const r = await fetch(ROUTER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(n),
        signal: AbortSignal.timeout(5000),
      })
      console.error(`[notify-mcp] ${sev} → router (${r.status})`)
      return asText({ ok: true, delivered: r.ok, logged: true })
    } catch (e) {
      console.error('[notify-mcp] router unreachable (logged locally):', e)
      return asText({ ok: true, delivered: false, logged: true, note: 'queued locally; router down' })
    }
  },
)

await server.connect(new StdioServerTransport())
console.error('[notify-mcp] ready →', ROUTER)
