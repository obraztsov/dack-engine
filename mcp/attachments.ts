/**
 * Channel-agnostic attachment-store helpers.
 *
 * The harness owns a media/attachment dir (injected into every MCP server as MEDIA_DIR, absolute). A
 * file-SENDING tool (telegram `reply_document`, and later buzz/email egress) lets the model name a stored
 * file by a **basename** — never a path. `resolveAttachment` confines that id to the store: `basename()`
 * strips any directory components (no `../` traversal), then realpath + a store-prefix check reject symlink
 * escapes and require a regular file. So an outbound send can only ever reach a file the harness already
 * stored, not an arbitrary host path. Shared by every egress channel so the confinement is written once.
 */
import { basename, join, isAbsolute } from 'node:path'
import { statSync, realpathSync } from 'node:fs'

export type ResolvedAttachment = { path: string; name: string } | { error: string }

/** Text-ish extensions served as text. An ALLOWLIST (fail-closed): an unknown extension is refused, so a
 *  new binary format can never be silently shipped into the context window as "text". */
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.text', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log', '.xml', '.html', '.htm',
  '.rst', '.org', '.diff', '.patch', '.sql', '.sh', '.py', '.ts', '.js', '.rs', '.go',
])

/** Known-binary extensions get a SPECIFIC refusal naming the format, so the model stops rather than
 *  retrying — a vague "unsupported" invites a loop, an explicit "not wired up" is actionable. */
const KNOWN_BINARY: Record<string, string> = {
  '.pdf': 'PDF', '.docx': 'Word', '.doc': 'Word', '.xlsx': 'Excel', '.xls': 'Excel',
  '.pptx': 'PowerPoint', '.zip': 'ZIP', '.gz': 'gzip', '.tar': 'tar',
  '.png': 'PNG image', '.jpg': 'JPEG image', '.jpeg': 'JPEG image', '.gif': 'GIF image',
  '.webp': 'WebP image', '.mp3': 'audio', '.ogg': 'audio', '.oga': 'audio', '.wav': 'audio',
  '.mp4': 'video', '.mov': 'video', '.bin': 'binary',
}

/**
 * Is this attachment name servable as PLAINTEXT? (Name-based half of the gate; the caller must still sniff
 * the BYTES for a NUL, since a filename is attacker-controlled metadata and may lie.)
 *
 * Plaintext-only is the agreed first slice: a text file an agent sent can be read and acted on, while a
 * PDF/Word file is refused cleanly and can still be FORWARDED by id. Document extraction is the planned
 * extension point — teach this gate a new type and the confinement/cap/taint story is inherited unchanged.
 */
/**
 * Sanitize a model-supplied filename for a file the AGENT authored (the outbox write path).
 *
 * The name is attacker-reachable (an injected message can ask for a particular filename) AND it becomes
 * the filename the RECIPIENT sees, so it is normalized rather than merely rejected:
 *   - `basename()` first — no directory components, no `../` traversal;
 *   - collapsed to `[A-Za-z0-9._-]` so nothing shell-, header- or path-surprising survives;
 *   - no leading dot (no hidden files) and a length ceiling, extension preserved;
 *   - must pass `plaintextGate` — the agent can only author TEXT, so it cannot stage a fake `.pdf`/`.png`
 *     that a reader would trust by extension. Same type policy as the read side, both directions.
 */
export function sanitizeAttachmentName(raw: string): { name: string } | { error: string } {
  let n = basename(raw)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '') // no hidden/dot-leading names
  if (!n || n === '.' || n === '..') return { error: `"${raw}" is not a usable filename` }

  if (n.length > 80) {
    const dot = n.lastIndexOf('.')
    const ext = dot > 0 ? n.slice(dot) : ''
    n = n.slice(0, 80 - ext.length).replace(/[-.]+$/, '') + ext
  }
  const gate = plaintextGate(n)
  if ('error' in gate) {
    return {
      error: `you can only author PLAINTEXT files, and "${n}" isn't one (${gate.error.includes('not plaintext') ? 'binary type' : 'unrecognized extension'}). Use a .md / .txt / .csv / .json name.`,
    }
  }
  return { name: n }
}

export function plaintextGate(name: string): { ok: true; ext: string } | { error: string } {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : ''
  if (KNOWN_BINARY[ext]) {
    return {
      error: `"${name}" is a ${KNOWN_BINARY[ext]} file, not plaintext. Reading documents is not wired up yet — do not retry. You can still FORWARD this file by its attachment id, or ask the sender for the text.`,
    }
  }
  if (!TEXT_EXT.has(ext)) {
    return {
      error: `"${name}" has no recognized plaintext extension (${ext || 'none'}), so it is not served as text. Do not retry; forward the file instead.`,
    }
  }
  return { ok: true, ext }
}

export function resolveAttachment(mediaDir: string | undefined, id: string): ResolvedAttachment {
  if (!mediaDir) return { error: 'MEDIA_DIR not set — the attachment store is unavailable' }
  const name = basename(id) // strips any dir components → no `../` traversal
  if (!name || name === '.' || name === '..') return { error: 'invalid attachment id' }
  try {
    const real = realpathSync(join(mediaDir, name))
    const realDir = realpathSync(mediaDir)
    if (real !== realDir && !real.startsWith(realDir + '/')) return { error: 'attachment escapes the store' }
    if (!statSync(real).isFile()) return { error: 'attachment is not a regular file' }
    return { path: real, name }
  } catch {
    return { error: `attachment "${name}" not found in the store` }
  }
}

/**
 * Resolve a model-supplied WORKSPACE path to a real file: `ref` is relative to `WORKSPACE_DIR`
 * (`inbox/telegram/-54/97-spec.md`, `outbox/brief.md`, `repos/x/docs/a.md`) or absolute UNDER it. realpath +
 * prefix check (a symlink out of the workspace is refused), regular file only. The returned `name` is the
 * basename the recipient sees.
 */
export function resolveWorkspaceFile(workspaceDir: string | undefined, ref: string): ResolvedAttachment {
  if (!workspaceDir) return { error: 'WORKSPACE_DIR not set — the workspace is unavailable' }
  const r = (ref ?? '').trim()
  if (!r || r === '.' || r === '..') return { error: 'empty path' }
  try {
    const rootReal = realpathSync(workspaceDir)
    const candidate = isAbsolute(r) ? r : join(workspaceDir, r)
    const real = realpathSync(candidate)
    if (real !== rootReal && !real.startsWith(rootReal + '/')) return { error: `"${r}" is outside your workspace (${workspaceDir})` }
    if (!statSync(real).isFile()) return { error: `"${r}" is not a regular file` }
    return { path: real, name: basename(real) }
  } catch {
    return { error: `"${r}" not found in your workspace (${workspaceDir}); paths are relative to it, e.g. inbox/… or outbox/…` }
  }
}

/**
 * Resolve something SENDABLE: a workspace path first (the duck's own files, inbox documents, repo files);
 * else a bare basename in the legacy media store (images the channel stored). One resolver for every
 * egress tool (buzz `send_file`, telegram `reply_document`, email, the generic buzz `--file`).
 */
export function resolveSendable(workspaceDir: string | undefined, mediaDir: string | undefined, ref: string): ResolvedAttachment {
  const ws = resolveWorkspaceFile(workspaceDir, ref)
  if (!('error' in ws)) return ws
  if (!ref.includes('/') && mediaDir) {
    const m = resolveAttachment(mediaDir, ref)
    if (!('error' in m)) return m
  }
  return ws
}
