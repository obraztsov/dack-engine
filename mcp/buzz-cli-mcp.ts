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
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAttachment } from './attachments'
import { DEFAULT_DENY, deniedVerb, rejectsHostPathFlag, applySendDefaults } from './buzz-args'

const BIN = process.env.BUZZ_BIN || 'dack-soul/skills/buzz/bin/buzz'
const MEDIA_DIR = process.env.MEDIA_DIR
const RELAY = process.env.BUZZ_RELAY_URL || ''
const TIMEOUT_MS = (Number(process.env.BUZZ_CLI_TIMEOUT_SEC) || 45) * 1000
const MAX_OUT = 64 * 1024 // cap returned bytes so a huge query can't blow the context

// Verb deny-list + host-path flag guard are pure argv policy — see `buzz-args.ts` (unit-tested there).
const DENY = (process.env.BUZZ_CLI_DENY ?? DEFAULT_DENY.join(','))
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] })

function runBuzz(rawArgs: string[]): Promise<{ ok: boolean; out?: string; error?: string; code?: number }> {
  // Strip anything that would override our injected identity/relay/format; we control those.
  // (`let`, not `const` — reassigned by `applySendDefaults` below.)
  let args: string[] = []
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]
    if (a === '--relay' || a === '--private-key' || a === '--key') { i++; continue } // drop flag + its value
    if (a.startsWith('--relay=') || a.startsWith('--private-key=') || a.startsWith('--key=')) continue
    args.push(a)
  }
  // Convenience (not a lock): default a `messages send`/`send-diff` to the channel + message that woke this
  // cycle (harness scope_env → BUZZ_REPLY_CHANNEL/BUZZ_REPLY_TO), so a reply lands in the right thread even
  // if the model omits them. The model can still target ANY channel by passing --channel explicitly, in
  // which case the wake's reply-to is NOT applied (a cross-channel parent is rejected by the relay).
  // Pure + unit-tested in `buzz-args.ts` — this defaulting is exactly what silently broke cross-channel
  // sends, so it does not live inline any more.
  args = applySendDefaults(args, {
    replyChannel: process.env.BUZZ_REPLY_CHANNEL,
    replyTo: process.env.BUZZ_REPLY_TO,
  })
  // `--format` is a GLOBAL flag — it must come BEFORE the subcommand (buzz rejects it after). Prepend it
  // LAST, after the verb-based logic above has read the positional verbs.
  if (!args.some((a) => a === '--format')) args.unshift('--format', 'json')

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
    const d = deniedVerb(args, DENY)
    if (d) return asText({ ok: false, error: `buzz verb "${d}" is not allowed (irreversible/admin). Ask the operator if you need it.` })
    const hp = rejectsHostPathFlag(args)
    if (hp) {
      console.error(`[buzz-cli] REFUSED host-path flag ${hp.flag} on the generic tool`)
      return asText({
        ok: false,
        error: `"${hp.flag}" takes a filesystem path and is not allowed here — use the \`${hp.use}\` tool instead, which confines the file to your attachment store. (Your request was NOT sent.)`,
      })
    }
    const r = await runBuzz(args)
    return asText(r)
  },
)

server.registerTool(
  'send_file',
  {
    description:
      'Send a STORED file to a Buzz channel (the confined counterpart of `messages send --file`). ' +
      '`attachment_id` is the `file` basename from an `attachments` entry in a wake payload — never a path; ' +
      'only files the harness already stored can leave, so you cannot attach an arbitrary host file. ' +
      'Defaults to the channel + message that woke you; pass `channel` to post elsewhere.',
    inputSchema: {
      attachment_id: z.string().min(1).max(512),
      text: z.string().min(1).max(8000),
      channel: z.string().min(1).max(200).optional(),
    },
  },
  async ({ attachment_id, text, channel }: { attachment_id: string; text: string; channel?: string }) => {
    const a = resolveAttachment(MEDIA_DIR, attachment_id)
    if ('error' in a) {
      console.error(`[buzz-cli] send_file DENIED id=${JSON.stringify(attachment_id)} — ${a.error}`)
      return asText({ ok: false, error: a.error })
    }
    const ch = channel || process.env.BUZZ_REPLY_CHANNEL
    if (!ch) return asText({ ok: false, error: 'no channel: this wake carries no reply channel, so pass `channel` explicitly' })
    // Always pass --channel explicitly; `runBuzz`/`applySendDefaults` then threads the wake's reply-to ONLY
    // when `ch` IS the woke channel. (This used to be guarded here and then re-defaulted inside runBuzz —
    // which appended a cross-channel parent and made every send_file to another channel fail at the relay.)
    const args = ['messages', 'send', '--channel', ch, '--content', text, '--file', a.path]
    const r = await runBuzz(args)
    console.error(`[buzz-cli] send_file ${r.ok ? 'ok' : 'FAILED'} name=${a.name} ch=${ch.slice(0, 8)}…`)
    return asText(r)
  },
)

server.registerTool(
  'media_fetch',
  {
    description:
      'Fetch a Buzz attachment into your own attachment store so you can work with it (the relay keeps ' +
      'media behind signed Blossom auth, so a plain URL fetch gets 401). Pass the `sha` of an `attachments` ' +
      'entry from your wake payload. Returns the stored `attachment_id`: read a text file with the media ' +
      "`read_attachment` tool, or forward any file with `send_file`. (Images you can SEE are delivered by " +
      'the channel on wake — fetching one here stores it for forwarding, it does not show it to you.)',
    inputSchema: {
      sha: z.string().regex(/^[0-9a-f]{64}$/, 'a bare 64-hex sha256 from an attachments entry'),
      filename: z.string().min(1).max(200).optional(),
    },
  },
  async ({ sha, filename }: { sha: string; filename?: string }) => {
    if (!MEDIA_DIR) return asText({ ok: false, error: 'MEDIA_DIR not set — the attachment store is unavailable' })
    // The stored name is HARNESS-shaped, never model-shaped: a validated 64-hex sha + a sanitized extension.
    // So the model cannot steer the write (no traversal, no overwriting a soul file), and the name matches
    // what the ingress prefetch would have produced for the same object (idempotent, cache-friendly).
    const rawExt = filename?.includes('.') ? '.' + filename.split('.').pop() : ''
    const ext = rawExt.toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12)
    const name = `${sha}${ext}`
    try {
      mkdirSync(MEDIA_DIR, { recursive: true })
    } catch {
      /* harness ensures it at boot */
    }
    const r = await runBuzz(['media', 'get', sha, '-o', join(MEDIA_DIR, name)])
    if (!r.ok) {
      console.error(`[buzz-cli] media_fetch FAILED sha=${sha.slice(0, 12)}…`)
      return asText(r)
    }
    console.error(`[buzz-cli] media_fetch ok sha=${sha.slice(0, 12)}… → ${name}`)
    return asText({ ok: true, attachment_id: name, hint: 'read it with read_attachment, or forward it with send_file' })
  },
)

await server.connect(new StdioServerTransport())
console.error(`[buzz-cli] ready — bin=${BIN} relay=${RELAY || '(unset)'} deny=[${DENY.join(',')}]`)
