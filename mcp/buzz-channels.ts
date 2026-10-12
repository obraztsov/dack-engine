/**
 * The channel directory as the Buzz MCP servers see it: a thin, lazily-opened view over the ingress's
 * `channels` index (`INGRESS_ROUTES_DB`, written by `buzz-ingress.ts` on every discovery). Every tool that
 * takes a channel — the generic CLI, `send_file`, `own_replies`, `arm_thread`, the read tool — resolves
 * through here, so a NAME works everywhere an id did, and an id comes back labelled with its name.
 *
 * No index (env unset, file missing) ⇒ `null`: callers pass argv through untouched, exactly as before
 * this existed. Degrades, never blocks.
 */
import { existsSync } from 'node:fs'
import { openRoutesStore, resolveChannel, channelDirectoryLine, listChannels, type ChannelRef } from './ingress-routes'
import type { ChannelLookup } from './buzz-args'

export type ChannelIndex = {
  lookup: ChannelLookup
  /** `research (org) · marketing (org, unconfigured) · …` — for a tool description; '' when empty. */
  directory: string
  /** The label for a send result: `{id, name, trust}` for a resolved id (name null when not indexed). */
  describe: (id: string) => { id: string; name: string | null; trust: string | null; configured: boolean }
  names: string[]
}

export function openChannelIndex(path = process.env.INGRESS_ROUTES_DB): ChannelIndex | null {
  if (!path || !existsSync(path)) return null
  try {
    const db = openRoutesStore(path)
    const lookup: ChannelLookup = (ref) => resolveChannel(db, ref) as ChannelRef
    return {
      lookup,
      directory: channelDirectoryLine(db),
      describe: (id) => {
        const r = resolveChannel(db, id)
        return r.ok ? { id: r.id, name: r.name, trust: r.trust, configured: r.configured } : { id, name: null, trust: null, configured: false }
      },
      names: listChannels(db).map((c) => c.name),
    }
  } catch (e) {
    console.error('[buzz-channels] index unavailable:', (e as Error).message)
    return null
  }
}

/** Resolve a single tool parameter (`channel?`): a name → id, an id → itself; refuses an unknown name. */
export function resolveOne(idx: ChannelIndex | null, ref: string): { ok: true; id: string; name: string | null } | { ok: false; error: string } {
  if (!idx) return { ok: true, id: ref, name: null }
  const r = idx.lookup(ref)
  return r.ok ? { ok: true, id: r.id, name: r.name } : r
}
