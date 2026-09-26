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
import { execFile } from 'node:child_process'

const BIN = process.env.BUZZ_BIN || 'dack-soul/skills/buzz/bin/buzz'
const RELAY = process.env.BUZZ_RELAY_URL || ''
const TIMEOUT_MS = (Number(process.env.BUZZ_CLI_TIMEOUT_SEC) || 45) * 1000
const MAX_OUT = 64 * 1024 // cap returned bytes so a huge query can't blow the context

// Irreversible / admin verbs a chatting agent should not casually run. Matched against the first arg and
// the first-two args ("verb subverb"). Operator override: BUZZ_CLI_DENY="" allows everything.
const DEFAULT_DENY = [
  'agents', 'workflows', 'repos', 'projects', // identity / automation / git admin
  'messages delete', 'messages edit',
  'channels create', 'channels update', 'channels delete', 'channels leave',
]
const DENY = (process.env.BUZZ_CLI_DENY ?? DEFAULT_DENY.join(','))
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] })

/** Reject a denied verb (fail-closed) before we ever spawn. */
function denied(args: string[]): string | null {
  const verbs = args.filter((a) => !a.startsWith('-')) // positional path, e.g. ["messages","send", …]
  const one = (verbs[0] || '').toLowerCase()
  const two = `${one} ${(verbs[1] || '').toLowerCase()}`.trim()
  const hit = DENY.find((d) => d === one || d === two)
  return hit ? hit : null
}

function runBuzz(rawArgs: string[]): Promise<{ ok: boolean; out?: string; error?: string; code?: number }> {
  // Strip anything that would override our injected identity/relay/format; we control those.
  const args: string[] = []
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]
    if (a === '--relay' || a === '--private-key' || a === '--key') { i++; continue } // drop flag + its value
    if (a.startsWith('--relay=') || a.startsWith('--private-key=') || a.startsWith('--key=')) continue
    args.push(a)
  }
  // Convenience (not a lock): default a `messages send`/`send-diff` to the channel + message that woke this
  // cycle (harness scope_env → BUZZ_REPLY_CHANNEL/BUZZ_REPLY_TO), so a reply lands in the right thread even
  // if the model omits them. The model can still target ANY channel by passing --channel explicitly.
  const verbs0 = args.filter((a) => !a.startsWith('-'))
  const isSend = verbs0[0] === 'messages' && (verbs0[1] === 'send' || verbs0[1] === 'send-diff')
  if (isSend) {
    const has = (f: string) => args.some((a) => a === f || a === `-${f[2]}` || a.startsWith(`${f}=`))
    if (!has('--channel') && process.env.BUZZ_REPLY_CHANNEL) args.push('--channel', process.env.BUZZ_REPLY_CHANNEL)
    if (!has('--reply-to') && process.env.BUZZ_REPLY_TO) args.push('--reply-to', process.env.BUZZ_REPLY_TO)
  }
  if (!args.some((a) => a === '--format')) args.push('--format', 'json') // structured output by default

  const key = process.env.BUZZ_PRIVATE_KEY
  if (!key) return Promise.resolve({ ok: false, error: 'BUZZ_PRIVATE_KEY not set — identity unavailable' })
  if (!RELAY) return Promise.resolve({ ok: false, error: 'BUZZ_RELAY_URL not set' })

  return new Promise((resolve) => {
    execFile(
      BIN,
      args,
      {
        env: { PATH: process.env.PATH, BUZZ_PRIVATE_KEY: key, BUZZ_RELAY_URL: RELAY },
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUT,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const out = (stdout || '').slice(0, MAX_OUT)
        if (err) {
          // buzz-cli emits JSON errors on stderr; surface them but never the argv/env.
          const msg = (stderr || (err as Error).message || 'buzz failed').slice(0, 2000)
          console.error(`[buzz-cli] FAILED verb=${args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')} code=${(err as any).code}`)
          resolve({ ok: false, error: msg, code: (err as any).code })
        } else {
          console.error(`[buzz-cli] ok verb=${args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')}`)
          resolve({ ok: true, out: out || (stderr || '').slice(0, MAX_OUT) })
        }
      },
    )
  })
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
      'a few irreversible/admin verbs (delete, leave, agents/workflows/repos/projects) are blocked.',
    inputSchema: { args: z.array(z.string().min(1)).min(1).max(40) },
  },
  async ({ args }: { args: string[] }) => {
    const d = denied(args)
    if (d) return asText({ ok: false, error: `buzz verb "${d}" is not allowed (irreversible/admin). Ask the operator if you need it.` })
    const r = await runBuzz(args)
    return asText(r)
  },
)

await server.connect(new StdioServerTransport())
console.error(`[buzz-cli] ready — bin=${BIN} relay=${RELAY || '(unset)'} deny=[${DENY.join(',')}]`)
