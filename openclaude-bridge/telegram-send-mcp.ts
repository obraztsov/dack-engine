/**
 * Telegram EGRESS — the PRIVILEGED **send-initiation** capability (the sibling of `telegram-mcp.ts`).
 *
 * Where `telegram` is `reply{text}` — destination-LOCKED to the chat that woke the cycle, OPEN to any
 * tier — this server is `send_message{to, text}`: a PROACTIVE send to a destination the duck CHOOSES,
 * with no inbound message. That power is gated three ways:
 *   1. **min_trust: org** in the MCP registry — the harness only assembles this server for an org+
 *      cycle (operator `dack say`, a Telegram-org message, the duck's own trusted Reflect/digest). A
 *      `public` cycle (a stranger DM, a public group, a degraded cycle) never gets the tool — a
 *      prompt-injection can't make the duck spam. The firebreak lives in Rust; this file is the hands.
 *   2. **allow-list, fail-closed** — `to` resolves to a chat_id ONLY via one of:
 *        (a) a symbolic NAME in the operator-registered `named` map;
 *        (b) an explicit GROUP id in `groups` (groups are always operator-configured, never wildcard);
 *        (c) a KNOWN PRIVATE contact — a positive (user) chat_id that has actually messaged the duck
 *            (verified against the runlog), enabled only when `allow_known_private` is set.
 *      A raw / hallucinated / injected chat_id that is none of these → denied, sends nothing. So the
 *      CEO duck can DM the clients it has talked to, but can NEVER be tricked into DMing a stranger it
 *      has never heard from.
 *   3. the runlog check bounds "known" to retention (a very cold contact ages out → falls back to
 *      operator-registering it by name). A persistent contacts store is the upgrade path for true-ever.
 *
 * TELEGRAM_DESTINATIONS json (backward compatible):
 *   - structured: {"named":{"operator":80375347},"groups":[-5426732960],"allow_known_private":true}
 *   - LEGACY flat: {"operator":80375347,"group":-5426732960}  → treated as `named` (no wildcard).
 *
 * Token: `TELEGRAM_BOT_TOKEN` (harness-injected, never the agent context). Raw Bot API `fetch`.
 * stdout is the MCP protocol channel — NEVER log to it; use stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Database } from 'bun:sqlite'
import { z } from 'zod'

type Destinations = {
  named: Record<string, number | string> // symbolic name → chat_id (operator-registered)
  groups: number[] // explicit allowed GROUP chat_ids (never wildcard)
  allow_known_private: boolean // allow DM to any PRIVATE chat that has messaged the duck (runlog-verified)
}

// Static env from the gitignored config — NOT the soul — so the duck reaches only operator-sanctioned
// destinations. Empty/missing ⇒ nothing is sendable.
function loadDestinations(): Destinations {
  const empty: Destinations = { named: {}, groups: [], allow_known_private: false }
  const raw = process.env.TELEGRAM_DESTINATIONS
  if (!raw) return empty
  try {
    const m = JSON.parse(raw)
    if (!m || typeof m !== 'object') return empty
    if ('named' in m || 'groups' in m || 'allow_known_private' in m) {
      return {
        named: m.named && typeof m.named === 'object' ? m.named : {},
        groups: Array.isArray(m.groups) ? m.groups.map(Number).filter(Number.isFinite) : [],
        allow_known_private: !!m.allow_known_private,
      }
    }
    // LEGACY flat map { "<name>": <chat_id> } → named-only (the live duck's shape; no wildcard).
    return { named: m, groups: [], allow_known_private: false }
  } catch (e) {
    console.error('[telegram-send] bad TELEGRAM_DESTINATIONS json:', e)
    return empty
  }
}

const DESTS = loadDestinations()
const NAMES = Object.keys(DESTS.named)

// Open the runlog READ-ONLY only when the known-private wildcard is enabled (the live duck never does,
// so it never touches the DB). `PRAGMA query_only` = a hard guarantee this can never write it.
let db: Database | null = null
if (DESTS.allow_known_private && process.env.RUNLOG_DB) {
  try {
    db = new Database(process.env.RUNLOG_DB)
    db.exec('PRAGMA query_only=ON')
  } catch (e) {
    console.error('[telegram-send] runlog open failed (known-private DISABLED, fail-closed):', e)
    db = null
  }
}

/** Has this PRIVATE chat_id actually messaged the duck? (a telegram-sourced runlog entry tagged with it).
 *  No DB / no row ⇒ false ⇒ fail-closed. */
function isKnownPrivateContact(chatId: number): boolean {
  if (!db) return false
  try {
    const row = db
      .query(
        "SELECT 1 FROM entry_tags et JOIN entries e ON e.run_id = et.run_id " +
          "WHERE et.tag = ?1 AND e.source LIKE 'telegram%' LIMIT 1",
      )
      .get(String(chatId))
    return !!row
  } catch (e) {
    console.error('[telegram-send] runlog query failed (fail-closed):', e)
    return false
  }
}

/** Resolve `to` → a chat_id, or null (denied). Fail-closed at every branch. */
function resolveTarget(to: string): number | string | null {
  const t = to.trim()
  if (Object.prototype.hasOwnProperty.call(DESTS.named, t)) return DESTS.named[t] // (a) named
  if (!/^-?\d+$/.test(t)) return null // not a name and not a numeric id → denied
  const n = Number(t)
  if (DESTS.groups.includes(n)) return n // (b) explicitly allowed group
  if (DESTS.allow_known_private && n > 0 && isKnownPrivateContact(n)) return n // (c) known private (user) chat
  return null
}

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
  console.error('[telegram-send] sent message_id=', j?.result?.message_id, 'to', j?.result?.chat?.id)
  return { ok: true, message_id: j?.result?.message_id, chat_id: j?.result?.chat?.id }
}

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] })

const server = new McpServer({ name: 'telegram-send', version: '0.1.0' })

const privateNote = DESTS.allow_known_private
  ? ` You may ALSO send to the numeric chat_id of a user who has messaged you before (validated); ` +
    `you cannot reach a user who has never contacted you.`
  : ''

server.registerTool(
  'send_message',
  {
    description:
      `Proactively send a Telegram message (NOT a reply), ≤4096 chars. \`to\` must be a registered ` +
      `destination name${NAMES.length ? ` (${NAMES.join(', ')})` : ' (none configured)'}` +
      `${DESTS.groups.length ? ` or an allowed group chat_id` : ''}.${privateNote} ` +
      `A chat_id you can't justify is refused. Use this to initiate (announce, ping, follow up); to ` +
      `answer a chat that just messaged you, use the reply tool instead.`,
    inputSchema: { to: z.string().min(1), text: z.string().min(1).max(4096) },
  },
  async ({ to, text }: { to: string; text: string }) => {
    const chat = resolveTarget(to)
    if (chat === null) {
      return asText({
        ok: false,
        error: `destination "${to}" not allowed`,
        allowed_names: NAMES,
        allow_known_private: DESTS.allow_known_private,
      })
    }
    return asText(await tgSend({ chat_id: chat, text }))
  },
)

await server.connect(new StdioServerTransport())
console.error(
  `[telegram-send] ready; named: ${NAMES.join(', ') || '(none)'}; groups: ${DESTS.groups.length}; ` +
    `known_private: ${DESTS.allow_known_private}`,
)
