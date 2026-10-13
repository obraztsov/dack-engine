/**
 * Buzz CLI capability — a **generic, thin wrapper** around the `buzz` binary (block/buzz Nostr client),
 * the openclaude-native counterpart to the signed `RunSkillCommand` buzz skill (which only runs on the
 * duck-loop runtime). ONE tool, `buzz`, that runs `bin/buzz <args…>` and returns its JSON — so the model
 * gets the WHOLE CLI surface (messages, channels, dms, users, media, feed, social) with the operations
 * taught in the state prompt, rather than a hand-carved tool per verb.
 *
 * Trust model (this is a "dumb" wrapper — no per-call destination-lock, unlike telegram-mcp, so the model
 * chooses the channel/target):
 *   1. **min_trust: org** in the registry — the harness only assembles this server for an org+ cycle, so a
 *      public/stranger buzz message can never reach it (the wall drops it for a lower-trust cycle).
 *   2. **No shell** — args are an array, spawned via execFile (NO `sh -c`), so there is no shell-injection
 *      surface; the model can only run the `buzz` program with argv it supplies.
 *   3. **Identity + relay injected here** — BUZZ_PRIVATE_KEY (the scoped secret) + BUZZ_RELAY_URL are set in
 *      the child env by the harness/this server; the model never supplies (or sees) them, and any `--relay`
 *      the model passes is stripped.
 *   4. **Deny-list** (BUZZ_CLI_DENY) — a fail-closed block on irreversible/admin verbs (delete, leave,
 *      identity/automation/git admin) so a trusted-but-injected cycle can't nuke a channel. Configurable.
 *
 * Env (harness-injected): BUZZ_PRIVATE_KEY (secret), BUZZ_RELAY_URL, BUZZ_BIN (path to the binary),
 * BUZZ_CLI_DENY (comma-separated denied verbs / "verb subverb"), BUZZ_CLI_TIMEOUT_SEC.
 * stdout is the MCP protocol channel — NEVER log to it; use stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSendable } from './attachments'
import { execBuzz, stripIdentityFlags, BUZZ_BIN, BUZZ_RELAY, type BuzzResult } from './buzz-exec'
import { DEFAULT_DENY, deniedVerb, confineHostPathFlags, applySendDefaults, resolveChannelFlags, flagValue, coerceArgs } from './buzz-args'
import { registerOwnRepliesTool } from './buzz-thread'
import { openChannelIndex, resolveOne } from './buzz-channels'

const MEDIA_DIR = process.env.MEDIA_DIR
const WORKSPACE_DIR = process.env.WORKSPACE_DIR
const sendable = (ref: string) => resolveSendable(WORKSPACE_DIR, MEDIA_DIR, ref)

// Verb deny-list + host-path flag guard are pure argv policy — see `buzz-args.ts` (unit-tested there).
const DENY = (process.env.BUZZ_CLI_DENY ?? DEFAULT_DENY.join(','))
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] })

// The channel directory (names ⇄ ids) the ingress maintains. Opened once per server (one server per step).
const CHANNELS = openChannelIndex()

async function runBuzz(rawArgs: string[]): Promise<BuzzResult & { channel?: unknown }> {
  // Identity/relay flags stripped; `--channel <name>` resolved to its id through the ingress index (an
  // unknown name refuses the whole command — nothing is sent to a guessed room); then the wake-scoped send
  // defaults (pure, unit-tested in buzz-args.ts — that defaulting is exactly what silently broke
  // cross-channel sends). Spawning itself is shared with the read-only server via `execBuzz`.
  let clean = stripIdentityFlags(rawArgs)
  if (CHANNELS) {
    const r = resolveChannelFlags(clean, CHANNELS.lookup)
    if (!r.ok) {
      console.error(`[buzz-cli] REFUSED unresolved channel: ${r.error.slice(0, 120)}`)
      return { ok: false, error: `${r.error} (nothing was sent)` }
    }
    clean = r.args
  }
  const args = applySendDefaults(clean, {
    replyChannel: process.env.BUZZ_REPLY_CHANNEL,
    replyTo: process.env.BUZZ_REPLY_TO,
  })
  const res = await execBuzz(args, 'buzz-cli')
  // A send comes back labelled with WHERE it went (id + name + trust), so a wrong room is visible to the
  // duck that chose it instead of being narrated as success ("forwarded to research" — it was marketing).
  const positional = args.filter((a) => !a.startsWith('-'))
  const target = flagValue(args, '--channel')
  if (positional[0] === 'messages' && positional[1]?.startsWith('send') && target && CHANNELS) {
    return { ...res, channel: CHANNELS.describe(target) }
  }
  return res
}

const server = new McpServer({ name: 'buzz-cli', version: '0.1.0' })

server.registerTool(
  'buzz',
  {
    description:
      'Run the Buzz CLI (Nostr workspace). Pass `args` as an ARRAY of the subcommand + flags, e.g. ' +
      '`["messages","send","--channel","<channel_id>","--content","<text>","--reply-to","<event_id>"]`. ' +
      'Your identity and the relay are injected — do NOT pass --relay or any key; output is JSON. ' +
      'Common ops: messages send|get|thread|search · channels list|get|search|join · dms list|open|send · ' +
      'users get|set-profile · media get · feed get · social publish. To reply where you were woken, send to ' +
      "the wake's `conversation` channel with `--reply-to` its `in_reply_to`. This tool is org-trust only; " +
      'a few irreversible/admin verbs (delete, leave, agents/workflows/repos/projects) are blocked.' +
      (CHANNELS?.directory
        ? ` Address channels by NAME: \`--channel research\` (a name is resolved to its id; an unknown name is refused, nothing sent). Channels: ${CHANNELS.directory}.`
        : ''),
    // An array by contract; a JSON string is tolerated and repaired (`coerceArgs`) because the live model
    // ships long sends that way and the SDK's schema check would otherwise drop the act unseen.
    inputSchema: { args: z.union([z.array(z.string().min(1)).min(1).max(40), z.string().min(1)]) },
  },
  async ({ args: raw }: { args: string[] | string }) => {
    const c = coerceArgs(raw)
    if (!c.ok) return asText({ ok: false, error: c.error })
    if (c.repaired) console.error(`[buzz-cli] args arrived as a string — repaired to ${c.args.length} items`)
    const args = c.args
    const d = deniedVerb(args, DENY)
    if (d) return asText({ ok: false, error: `buzz verb "${d}" is not allowed (irreversible/admin). Ask the operator if you need it.` })
    // File-reading flags (`--file`, `--patch-file`, `--body-file`) are CONFINED to the workspace: a workspace
    // path is resolved to its real file, anything else refuses the whole command (the exfil hole the survey
    // found: `patches send --patch-file /any/host/file` would have published it). `--output` stays refused.
    const confined = confineHostPathFlags(args, sendable)
    if (!confined.ok) {
      console.error(`[buzz-cli] REFUSED host-path flag on the generic tool: ${confined.error.slice(0, 120)}`)
      return asText({ ok: false, error: confined.error })
    }
    const r = await runBuzz(confined.args)
    return asText(confined.files.length ? { ...r, files: confined.files.map((f) => f.slice(f.lastIndexOf('/') + 1)) } : r)
  },
)

server.registerTool(
  'send_file',
  {
    description:
      'Send a file from your WORKSPACE to a Buzz channel (the confined counterpart of `messages send --file`). ' +
      '`path` is relative to your workspace — a document you received (`inbox/…`, the `file` of an `attachments` ' +
      'entry), one you wrote (`outbox/brief.md`), or a file in a cloned repo (`repos/…`). Only workspace files ' +
      'can leave; an arbitrary host path is refused. Defaults to the channel + message that woke you; pass ' +
      '`channel` (a channel NAME or id) to post elsewhere. NOTE: this relay\'s CLI currently rejects plain-text ' +
      'uploads (.md/.txt → "unsupported file type") — for text, paste it in the message or commit it to a repo.',
    inputSchema: {
      path: z.string().min(1).max(512).optional(),
      attachment_id: z.string().min(1).max(512).optional(), // legacy alias of `path`
      text: z.string().min(1).max(8000),
      channel: z.string().min(1).max(200).optional(),
    },
  },
  async ({ path, attachment_id, text, channel }: { path?: string; attachment_id?: string; text: string; channel?: string }) => {
    const ref = path || attachment_id
    if (!ref) return asText({ ok: false, error: 'give `path` (relative to your workspace)' })
    const a = sendable(ref)
    if ('error' in a) {
      console.error(`[buzz-cli] send_file DENIED path=${JSON.stringify(ref)} — ${a.error}`)
      return asText({ ok: false, error: a.error })
    }
    const want = channel || process.env.BUZZ_REPLY_CHANNEL
    if (!want) return asText({ ok: false, error: 'no channel: this wake carries no reply channel, so pass `channel` explicitly' })
    const rc = resolveOne(CHANNELS, want)
    if (!rc.ok) return asText({ ok: false, error: `${rc.error} (nothing was sent)` })
    const ch = rc.id
    // Always pass --channel explicitly; `runBuzz`/`applySendDefaults` then threads the wake's reply-to ONLY
    // when `ch` IS the woke channel. (This used to be guarded here and then re-defaulted inside runBuzz —
    // which appended a cross-channel parent and made every send_file to another channel fail at the relay.)
    const args = ['messages', 'send', '--channel', ch, '--content', text, '--file', a.path]
    const r = await runBuzz(args)
    console.error(`[buzz-cli] send_file ${r.ok ? 'ok' : 'FAILED'} name=${a.name} ch=${rc.name ?? ch.slice(0, 8)}`)
    if (r.ok && CHANNELS) return asText({ ...r, channel: CHANNELS.describe(ch) })
    return asText(r)
  },
)

server.registerTool(
  'media_fetch',
  {
    description:
      'Fetch a Buzz attachment into your WORKSPACE inbox (`inbox/buzz/<sha><ext>`) so you can work with it (the ' +
      'relay keeps media behind signed Blossom auth, so a plain URL fetch gets 401). Pass the `sha` of an ' +
      '`attachments` entry from your wake payload. Returns the workspace `path`: `Read` a text file there, or ' +
      'forward any file with `send_file`. (Images you can SEE are delivered on wake — fetching stores, it does not show.)',
    inputSchema: {
      sha: z.string().regex(/^[0-9a-f]{64}$/, 'a bare 64-hex sha256 from an attachments entry'),
      filename: z.string().min(1).max(200).optional(),
    },
  },
  async ({ sha, filename }: { sha: string; filename?: string }) => {
    if (!WORKSPACE_DIR) return asText({ ok: false, error: 'WORKSPACE_DIR not set — the workspace is unavailable' })
    // The stored name is HARNESS-shaped, never model-shaped: a validated 64-hex sha + a sanitized extension.
    // So the model cannot steer the write (no traversal, no overwriting a file), and the name matches what
    // the ingress prefetch produces for the same object (idempotent, cache-friendly).
    const rawExt = filename?.includes('.') ? '.' + filename.split('.').pop() : ''
    const ext = rawExt.toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12)
    const name = `${sha}${ext}`
    const dir = join(WORKSPACE_DIR, 'inbox', 'buzz')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* harness ensures the workspace at boot */
    }
    const r = await runBuzz(['media', 'get', sha, '-o', join(dir, name)])
    if (!r.ok) {
      console.error(`[buzz-cli] media_fetch FAILED sha=${sha.slice(0, 12)}…`)
      return asText(r)
    }
    const rel = `inbox/buzz/${name}`
    console.error(`[buzz-cli] media_fetch ok sha=${sha.slice(0, 12)}… → ${rel}`)
    return asText({ ok: true, path: rel, attachment_id: name, hint: `Read ${WORKSPACE_DIR}/${rel} (text) or forward it with send_file { path: "${rel}" }` })
  },
)

// "What did I already say here?" — read-only; the anti-duplicate INFORMATION the express step reads before
// replying in a thread it may have spoken in (no output filter — the model decides). Shared with buzz-read.
registerOwnRepliesTool(server, 'buzz-cli')

await server.connect(new StdioServerTransport())
console.error(`[buzz-cli] ready — bin=${BUZZ_BIN} relay=${BUZZ_RELAY || '(unset)'} deny=[${DENY.join(',')}]`)
