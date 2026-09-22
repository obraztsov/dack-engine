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
import { basename, join } from 'node:path'
import { statSync, realpathSync } from 'node:fs'

export type ResolvedAttachment = { path: string; name: string } | { error: string }

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
