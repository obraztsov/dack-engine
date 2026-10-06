/**
 * Outbox — the agent's own file-authoring lane: stage a plaintext file IT wrote, so it can actually SEND a
 * deliverable instead of only naming one in conversation.
 *
 * Why this exists: the core agent's `FileWrite` is gated to `writable_dirs`, which resolve against the SOUL
 * repo — in Express/Settle that is `memory/` and nothing else. So an agent could author a brief but had no
 * way to put it anywhere an egress tool could reach (only ingress modules write the attachment store). Every
 * file it produced was a filename it could mention but never deliver.
 *
 * Why CONTENT-based (`{name, text}`) and not path-based (`{path}`):
 *   - **No new read surface.** A path-based "upload this file" tool would reopen the question of which dirs
 *     may be published, and `memory/` is exactly the wrong answer: it is high-INTEGRITY (self-authored, org+
 *     gated) but high-SENSITIVITY — `social.md` alone is kilobytes of per-person, cross-chat notes. Taint
 *     tracks integrity, not confidentiality, so "trusted" never implied "safe to publish". A path upload
 *     would be a verbatim bulk-egress primitive for private notes, triggerable by one injected "attach your
 *     notes file" — and the runlog would record a filename, not the kilobytes that left.
 *   - **Deliberate + auditable.** Content passes through the model's own composition (where the discretion
 *     rules apply) and lands in the runlog, so what left is visible after the fact.
 *   - The agent can still send something it keeps in `memory/`: `Read` it, then write it here. Same outcome,
 *     but as an explicit act with judgment applied, rather than a blind byte move.
 *
 * Trust: declare this server **`trust: self`** — the bytes are the agent's OWN words, so staging them must
 * not floor the cycle (unlike the media READ server, which is `trust: public` because it handles what a
 * stranger sent). That is also why this is a SEPARATE server from `media-read-mcp.ts`: a server's trust
 * applies to every tool it exposes, so merging them would make authoring a draft cost the cycle its ceiling.
 * Declare it `tier: read` (a benign local write, NOT an outward act — it must not consume the cycle's
 * one-outward-act budget, which `Post` would) and admit it only in the EXPRESS prompts that need it.
 *
 * Files land in the shared attachment store so the existing confined egress tools resolve them by basename
 * with no changes: buzz `send_file`, telegram `reply_document`, email `reply_email`.
 *
 * Env (harness-injected): MEDIA_DIR (absolute, required), OUTBOX_MAX_BYTES (default 131072).
 * stdout is the MCP protocol channel — NEVER log to it; use stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitizeAttachmentName } from './attachments'

const MEDIA_DIR = process.env.MEDIA_DIR
const MAX_BYTES = Math.max(1024, Number(process.env.OUTBOX_MAX_BYTES) || 128 * 1024)

const asText = (v: unknown) => ({
  content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }],
})

const server = new McpServer({ name: 'outbox', version: '0.1.0' })

server.registerTool(
  'write_attachment',
  {
    description:
      'Stage a PLAINTEXT file you wrote, so you can send it as an attachment. Pass `name` (e.g. ' +
      '"staking-explainer.md" — this is the filename the recipient sees) and `text` (the full contents). ' +
      'Returns an `attachment_id` you then send with buzz `send_file` or telegram `reply_document`. Use it ' +
      'to DELIVER a draft or brief you have written — if the content lives in a memory/ file, Read it first, ' +
      'then pass the text here. Text only (.md/.txt/.csv/.json…); staging a file does not send it, and does ' +
      `not use up your one outward act. Max ${Math.floor(MAX_BYTES / 1024)}KB.`,
    inputSchema: {
      name: z.string().min(1).max(200),
      text: z.string().min(1),
    },
  },
  async ({ name, text }: { name: string; text: string }) => {
    if (!MEDIA_DIR) return asText({ ok: false, error: 'MEDIA_DIR not set — the attachment store is unavailable' })

    const s = sanitizeAttachmentName(name)
    if ('error' in s) {
      console.error(`[outbox] DENIED name=${JSON.stringify(name)} — ${s.error}`)
      return asText({ ok: false, error: s.error })
    }

    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_BYTES) {
      console.error(`[outbox] refused ${s.name} (${bytes}B > ${MAX_BYTES}B)`)
      return asText({
        ok: false,
        error: `that's ${Math.ceil(bytes / 1024)}KB — over the ${Math.floor(MAX_BYTES / 1024)}KB limit. Send a shorter version, or split it.`,
      })
    }

    try {
      mkdirSync(MEDIA_DIR, { recursive: true })
    } catch {
      /* harness ensures it at boot */
    }

    // Never clobber: the store also holds INBOUND attachments (what others sent us), and overwriting one
    // would both destroy evidence and let a staged file masquerade as a received one. Fail closed and let
    // the model pick another name — it keeps delivered filenames clean (no forced prefix) either way.
    const path = join(MEDIA_DIR, s.name)
    if (existsSync(path)) {
      console.error(`[outbox] refused ${s.name} (already in the store)`)
      return asText({
        ok: false,
        error: `"${s.name}" already exists in your attachment store (it may be a file someone sent you). Pick a different name, e.g. a version suffix.`,
      })
    }

    try {
      writeFileSync(path, text, { encoding: 'utf8', mode: 0o644, flag: 'wx' }) // wx = fail if it appeared since
    } catch (e) {
      console.error(`[outbox] write failed ${s.name}: ${(e as Error).message}`)
      return asText({ ok: false, error: `could not stage "${s.name}"` })
    }

    console.error(`[outbox] staged ${s.name} ${bytes}B`)
    return asText({
      ok: true,
      attachment_id: s.name,
      bytes,
      hint: 'now send it: buzz `send_file { attachment_id, text }` or telegram `reply_document { attachment_id }`',
    })
  },
)

await server.connect(new StdioServerTransport())
console.error(`[outbox] ready — store=${MEDIA_DIR || '(MEDIA_DIR unset!)'} cap=${MAX_BYTES}B plaintext-only`)
