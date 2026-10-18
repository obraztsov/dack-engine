/**
 * buzz-ingress — the duck's INBOUND bridge to Buzz (block/buzz, a Nostr workspace). A subscriber module,
 * the sibling of telegram-ingress: buzz-cli is one-shot, so this owns the poll loop. It:
 *   1. DISCOVERS the channels the duck is a member of (`channels list`) — membership IS the whitelist, so
 *      any channel/DM the duck is added to is watched automatically (config only OVERRIDES trust).
 *   2. POLLS each channel's history (`messages get --channel <id> --since <cursor>`) — full kind:9 events
 *      with p/e tags (the relay's `--types mentions` is NOT self-filtered, so we match tags ourselves).
 *   3. Detects a WAKE trigger — a MENTION (the duck's pubkey in the event's p-tags; a DM p-tags the
 *      recipient, so DMs are mentions) or a REPLY-TO-OWN (a reply/root e-tag → one of the duck's own recent
 *      message ids — the multi-agent coordination path, which carries no p-tag).
 *   4. POSTs a normalized stimulus to the harness's localhost webhook at a TIER-specific path
 *      (`/buzz/<tier>`). The path's tier (harness `webhooks:` map) is the seed trust; per-channel config
 *      only overrides it. All Buzz specifics live here; the Rust core just sees "a localhost webhook fired".
 *      A `wake:'all'` room may name an `ambient_path`: overheard traffic (no mention / reply / armed thread)
 *      goes there keyed per channel, so one slow batched duty digests the room while direct traffic stays fast.
 *
 * P0 (this file): discover + poll + detect + POST (wake & reply). Thread-spine context is P1.
 * BUZZ_PRIVATE_KEY is injected by the module's `buzz_key` secret; never logged.
 */

import { openRoutesStore, lookupArm, upsertChannels, upsertReactions, reactionsFor, summarizeReactions, type ReactionSummary } from './ingress-routes'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, isAbsolute, resolve as resolvePath } from 'node:path'

// ── config ───────────────────────────────────────────────────────────────────────────────────────

interface ChannelCfg {
  // Match by `id` OR by `name` (case-insensitive): an operator writes `{ name: "marketing", trust: "org" }`
  // and never copies a UUID; the relay is the authority on which id that name has today.
  id?: string
  name?: string
  trust?: string // override
  // Per-channel wake policy: 'all' = every message by someone else wakes the duck (org rooms — so a peer's
  // untagged question is SEEN; pair with the lane rule in the prompt so it doesn't become louder monologue);
  // 'mention' = only @-mentions / replies to own (the global `wake_on` default).
  wake?: 'all' | 'mention'
  // AMBIENT routing (only meaningful with `wake: 'all'`): a message that is NOT a mention, NOT a reply to
  // one of the duck's own posts and NOT in a thread the duck armed is "ambient" — overheard room traffic
  // (a worker's progress stream, two peers talking). With `ambient_path` set, such messages are POSTed to
  // that harness webhook path (e.g. "/buzz/org-ambient") instead of `/buzz/<tier>`, keyed PER CHANNEL
  // (`dedup_key: buzz:chan:<id>`) and without a spine, so the duty behind that path can batch the whole
  // room into one wake every N minutes while mentions / replies / armed threads stay on the fast path.
  // The path's tier still comes from the harness `webhooks:` map — this never changes trust.
  ambient_path?: string
}
interface Config {
  relay: string
  buzz_bin: string
  self_pubkey: string
  harness_webhook: string // e.g. http://127.0.0.1:8799
  routes_db: string // shared with ingress-arm-mcp: armed threads → entry_hint + tags on the wake
  poll_interval_secs: number
  discover_interval_secs: number
  cursor_file: string
  first_run_lookback_secs: number
  wake_on: string[] // ["mention","reply_to_own"]
  own_ids_window: number
  default_trust: string
  dm_default_trust: string
  channels: ChannelCfg[]
  thread_context: { max_ancestors: number; full_thread_max: number }
  // P2 media prefetch: passively fetch a small thumb (or the full image) of an attachment into the harness
  // media dir, so the duck SEES it on wake with no fetch. `off` (default) = awareness-only; the duck still
  // pulls full-res on demand via the `media_get` skill. `media_dir` MUST match the engine's `media_dir` (it's
  // where the harness resolves + confines media from); an absolute path is safest (the module's cwd may vary).
  media_prefetch: 'off' | 'thumb' | 'full'
  // Prefetch NON-image documents (pdf/docx/…) into the store too. Unlike images these are never loaded as
  // vision — they become routable stored attachments (a `file` on the attachment entry) the duck can forward
  // (e.g. `reply_document` a doc a paperwork agent returned over Buzz). Off by default (bandwidth/opt-in).
  media_prefetch_docs: boolean
  media_dir: string
  media_max_per_message: number
}

const DEFAULTS: Config = {
  relay: 'http://localhost:3000',
  buzz_bin: 'skills/buzz/bin/buzz',
  self_pubkey: '',
  harness_webhook: 'http://127.0.0.1:8787',
  routes_db: 'ingress-routes.sqlite',
  poll_interval_secs: 10,
  discover_interval_secs: 60,
  cursor_file: 'buzz-ingress.cursor',
  first_run_lookback_secs: 3600,
  wake_on: ['mention', 'reply_to_own'],
  own_ids_window: 500,
  default_trust: 'public',
  dm_default_trust: 'public',
  channels: [],
  thread_context: { max_ancestors: 8, full_thread_max: 40 },
  media_prefetch: 'off',
  media_prefetch_docs: false,
  media_dir: 'media',
  media_max_per_message: 6,
}

function loadConfig(): Config {
  const path = process.env.BUZZ_INGRESS_CONFIG ?? 'buzz-ingress.config.json'
  let cfg = { ...DEFAULTS }
  if (existsSync(path)) cfg = { ...cfg, ...JSON.parse(readFileSync(path, 'utf8')) }
  if (!cfg.self_pubkey) throw new Error('buzz-ingress: config.self_pubkey (the duck pubkey) is required')
  if (!process.env.BUZZ_PRIVATE_KEY) throw new Error('buzz-ingress: BUZZ_PRIVATE_KEY not in env (inject the buzz_key secret)')
  return cfg
}

const cfg = loadConfig()
const routes = openRoutesStore(cfg.routes_db)
const log = (...a: unknown[]) => console.error('[buzz-ingress]', ...a)

// ── buzz-cli (one-shot, JSON out) ──────────────────────────────────────────────────────────────────

/** Run the buzz binary with the relay + key, returning parsed JSON (or null on failure). Never throws. */
function buzz(args: string[]): any {
  const env: Record<string, string> = {}
  for (const k of ['PATH', 'HOME', 'LANG']) if (process.env[k] !== undefined) env[k] = process.env[k]!
  env.BUZZ_PRIVATE_KEY = process.env.BUZZ_PRIVATE_KEY! // to the child only
  const proc = Bun.spawnSync([cfg.buzz_bin, '--relay', cfg.relay, '--format', 'json', ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const out = proc.stdout.toString().trim()
  if (!out) {
    if (proc.exitCode !== 0) log('buzz', args.join(' '), 'failed:', proc.stderr.toString().slice(0, 200))
    return null
  }
  try {
    const j = JSON.parse(out)
    if (j && typeof j === 'object' && !Array.isArray(j) && j.error) {
      log('buzz', args[0], args[1] ?? '', 'error:', j.message?.slice(0, 160))
      return null
    }
    return j
  } catch {
    return null
  }
}

/** Fetch a media object (Blossom signed-GET) to a FILE — a side-effect exec, NOT the JSON `buzz()` path.
 *  `ref` is a `sha256[.ext]` segment (bare sha, or `<sha>.thumb.jpg`). Returns true on a clean write. */
function buzzMediaGet(ref: string, outPath: string): boolean {
  const env: Record<string, string> = {}
  for (const k of ['PATH', 'HOME', 'LANG']) if (process.env[k] !== undefined) env[k] = process.env[k]!
  env.BUZZ_PRIVATE_KEY = process.env.BUZZ_PRIVATE_KEY!
  const proc = Bun.spawnSync([cfg.buzz_bin, '--relay', cfg.relay, 'media', 'get', ref, '-o', outPath], { env, stdout: 'ignore', stderr: 'pipe' })
  if (proc.exitCode !== 0) {
    log('media get', ref.slice(0, 12), 'failed:', proc.stderr.toString().slice(0, 160))
    return false
  }
  return true
}

const mediaDirAbs = () => (isAbsolute(cfg.media_dir) ? cfg.media_dir : resolvePath(process.cwd(), cfg.media_dir))
// The agent WORKSPACE (harness-injected, absolute): documents land in its `inbox/`. Falls back beside the cwd.
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? resolvePath(process.cwd(), 'workspace')

/** P2 passive awareness: prefetch a thumb (or full image) of each attachment into the harness media dir and
 *  return `payload.media` entries the engine's media store confines + carries onto the goal turn (so the duck
 *  SEES it on wake). Cached by filename (sha-named) — a repeat is a no-op. `off` ⇒ nothing (on-demand only). */
function prefetchMedia(attachments: MediaMeta[]): Array<{ kind: 'image'; file: string; mime: string }> {
  if (cfg.media_prefetch === 'off' || attachments.length === 0) return []
  const dir = mediaDirAbs()
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* harness ensures it at boot; ignore */
  }
  const out: Array<{ kind: 'image'; file: string; mime: string }> = []
  for (const a of attachments.slice(0, cfg.media_max_per_message)) {
    if (!a.sha) continue
    const useThumb = cfg.media_prefetch === 'thumb' && a.has_thumb
    const file = useThumb ? `${a.sha}.thumb.jpg` : a.sha // basename (hex sha) → safe; engine re-confines it
    const mime = useThumb ? 'image/jpeg' : a.mime
    if (!mime.startsWith('image/')) continue // the engine's media store only carries images
    const outPath = join(dir, file)
    if (existsSync(outPath)) {
      out.push({ kind: 'image', file, mime }) // cache hit — no refetch
    } else if (buzzMediaGet(file, outPath)) {
      out.push({ kind: 'image', file, mime })
      log('prefetched', useThumb ? 'thumb' : 'image', `${file.slice(0, 12)}… (${mime}) → media dir`)
    }
  }
  return out
}

// ── event helpers ───────────────────────────────────────────────────────────────────────────────

type Ev = { id: string; kind: number; pubkey: string; content: string; created_at: number; tags: string[][] }
const pTags = (ev: Ev) => (ev.tags ?? []).filter((t) => t[0] === 'p').map((t) => t[1])
const eRefs = (ev: Ev) => (ev.tags ?? []).filter((t) => t[0] === 'e').map((t) => ({ id: t[1], marker: t[3] ?? '' }))
/** The thread root of an event: its NIP-10 `root` e-tag, else its `reply` e-tag, else itself (it IS a root). */
function rootOf(ev: Ev): string {
  const refs = eRefs(ev)
  return refs.find((r) => r.marker === 'root')?.id ?? refs.find((r) => r.marker === 'reply')?.id ?? ev.id
}

/** A single kind:9 event by id (Mode-A hop). */
function eventById(id: string): Ev | null {
  const r = buzz(['social', 'event', '--event', id])
  const e = Array.isArray(r) ? r[0] : r
  return e && e.id ? (e as Ev) : null
}

// Author names (kind:0 profiles), cached — so the duck reads "Hermes said …", not a hex pubkey (important
// for multi-agent coordination). A nameless/unknown author falls back to a short pubkey.
const nameCache = new Map<string, string>()
function resolveName(pubkey: string): string {
  const hit = nameCache.get(pubkey)
  if (hit !== undefined) return hit
  const r = buzz(['users', 'get', '--pubkey', pubkey])
  const prof = Array.isArray(r) ? r[0] : r
  const name = (prof && (prof.display_name || prof.name)) || pubkey.slice(0, 8)
  nameCache.set(pubkey, name)
  return name
}

type SpineEv = { id: string; from: string; from_name: string; content: string; created_at: number; attachments?: MediaMeta[]; reactions?: ReactionSummary[] }
const compactEv = (e: Ev): SpineEv => {
  const attachments = parseImeta(e) // P3: an ancestor's images are fetchable too (media_get by sha)
  // Reactions seen on this message (kind:7, polled into the routes store): a 👀 from a worker on a task post
  // IS its acknowledgement — present only when there are any, so a reaction-less wake is byte-for-byte unchanged.
  const reactions = summarizeReactions(reactionsFor(routes, e.id), (p) => (p === cfg.self_pubkey ? 'you' : resolveName(p)))
  return {
    id: e.id,
    from: e.pubkey,
    from_name: resolveName(e.pubkey),
    content: e.content,
    created_at: e.created_at,
    ...(attachments.length ? { attachments } : {}),
    ...(reactions.length ? { reactions } : {}),
  }
}

// Media attachments (NIP-92 `imeta` tags). Each imeta tag is ["imeta", "url <U>", "m <mime>", "x <sha256>",
// "size <bytes>", "dim <WxH>", "thumb <U>", "filename <name>", …] — space-separated `key value` fields (only
// the value may contain spaces, e.g. a filename → split on the FIRST space). P0 surfaces METADATA ONLY (the
// duck's awareness that media exists); no bytes move here. The bytes live behind Blossom auth — fetching them
// (`buzz media get`, a signed GET) and turning them into a vision block is P1. `sha` (the `x` hash) is the
// stable ref P1's `media_get` will pull. Capped like the harness's MAX_MEDIA_PER_STIMULUS.
type MediaMeta = { sha: string | null; mime: string; dim: string | null; size: number | null; filename: string | null; has_thumb: boolean; file?: string }

const EXT_FOR_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/zip': '.zip',
}
/** Prefetch NON-image documents into the store: fetch full bytes (Blossom authed) and STAMP `file` (the
 *  stored basename) onto each fetched attachment entry, so a Buzz-received document becomes a routable stored
 *  attachment (channel-agnostic with telegram). Mutates the entries; no-op unless `media_prefetch_docs`. */
function prefetchDocsInto(attachments: MediaMeta[], channelName?: string): void {
  if (!cfg.media_prefetch_docs || attachments.length === 0) return
  // Documents land in the duck's WORKSPACE inbox: `inbox/buzz/<channel>/<sha12>-<filename>` — a path the duck
  // can `Read` (wall-gated, trust-capped) or `send_file` on; `file` is that workspace-relative path.
  const chan = (channelName ?? 'channel').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'channel'
  const dir = join(WORKSPACE_DIR, 'inbox', 'buzz', chan)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* harness ensures the workspace at boot */
  }
  for (const a of attachments.slice(0, cfg.media_max_per_message)) {
    if (!a.sha || a.mime.startsWith('image/')) continue // images ride prefetchMedia (the vision lane)
    const ext = (a.filename?.includes('.') ? '.' + a.filename.split('.').pop() : EXT_FOR_MIME[a.mime]) ?? '.bin'
    const safe = (a.filename ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 100)
    const file = safe || `${a.sha}${ext.toLowerCase().replace(/[^a-z0-9.]/g, '')}`
    const name = `${a.sha.slice(0, 12)}-${file}`
    const outPath = join(dir, name)
    if (existsSync(outPath) || buzzMediaGet(a.sha, outPath)) {
      a.file = `inbox/buzz/${chan}/${name}`
      log('prefetched doc', `${a.sha.slice(0, 12)}… (${a.mime}) → ${a.file}`)
    }
  }
}
function parseImeta(ev: Ev): MediaMeta[] {
  const out: MediaMeta[] = []
  for (const t of ev.tags ?? []) {
    if (t[0] !== 'imeta') continue
    const kv: Record<string, string> = {}
    for (const field of t.slice(1)) {
      const sp = typeof field === 'string' ? field.indexOf(' ') : -1
      if (sp > 0) kv[field.slice(0, sp)] = field.slice(sp + 1)
    }
    if (!kv.url && !kv.x) continue // not a media imeta
    out.push({
      sha: kv.x ?? null,
      mime: kv.m ?? 'application/octet-stream',
      dim: kv.dim ?? null,
      size: kv.size ? Number(kv.size) : null,
      filename: kv.filename ?? null,
      has_thumb: !!kv.thumb,
    })
    if (out.length >= 6) break
  }
  return out
}

/** Reconstruct the ancestor SPINE — root → … → parent → trigger, oldest→newest. Mode A: walk the NIP-10
 *  `reply` e-tag hop-by-hop (each hop = one ancestor, so the MIDDLE threading points are kept), fetching one
 *  event per hop, bounded by `max_ancestors`. `truncated` = the thread is deeper than we walked (the duck can
 *  `thread_get` the root for the rest). A root event → a one-element spine. */
function buildSpine(ev: Ev): { spine: SpineEv[]; truncated: boolean; root: string } {
  const chain: Ev[] = [ev]
  let cur = ev
  let truncated = false
  for (;;) {
    const refs = eRefs(cur)
    // immediate parent = the `reply`-marked e-tag (buzz marks them); fall back to the last unmarked e-tag.
    const reply = refs.find((r) => r.marker === 'reply') ?? (refs.length && refs.every((r) => !r.marker) ? refs[refs.length - 1] : undefined)
    if (!reply) break // cur is the thread root
    if (chain.length > cfg.thread_context.max_ancestors) {
      truncated = true
      break
    }
    const parent = eventById(reply.id)
    if (!parent) {
      truncated = true
      break
    }
    chain.unshift(parent)
    cur = parent
  }
  return { spine: chain.map(compactEv), truncated, root: rootOf(ev) }
}

// ── cursor + own-id state ──────────────────────────────────────────────────────────────────────────

let cursor: Record<string, number> = existsSync(cfg.cursor_file) ? JSON.parse(readFileSync(cfg.cursor_file, 'utf8')) : {}
const saveCursor = () => writeFileSync(cfg.cursor_file, JSON.stringify(cursor))
const ownIds = new Set<string>() // rolling window of the duck's own message ids (for reply-to-own)
const seen = new Set<string>() // event ids already forwarded (in-process dedup)

function rememberOwn(id: string): void {
  ownIds.add(id)
  if (ownIds.size > cfg.own_ids_window) ownIds.delete(ownIds.values().next().value as string)
}

// ── trust ──────────────────────────────────────────────────────────────────────────────────────────

/** The operator's config entry for a relay channel — by id, or by name (case-insensitive). */
function cfgFor(ch: { id: string; name?: string }): ChannelCfg | undefined {
  return cfg.channels.find((c) => (c.id && c.id === ch.id) || (!c.id && c.name && ch.name && c.name.toLowerCase() === ch.name.toLowerCase()))
}

function tierFor(ch: { id: string; name?: string }): string {
  const ov = cfgFor(ch)?.trust
  if (ov) return ov
  return (ch.name ?? '').toLowerCase() === 'dm' ? cfg.dm_default_trust : cfg.default_trust
}

// ── discovery + poll ────────────────────────────────────────────────────────────────────────────────

let channels: { id: string; name?: string }[] = []
function discover(): void {
  const list = buzz(['channels', 'list'])
  if (Array.isArray(list)) {
    channels = list.map((c: any) => ({ id: c.channel_id, name: c.name }))
    // Publish the CHANNEL INDEX (name ⇄ id + the trust this config assigns) for the Buzz MCPs, which resolve
    // `--channel <name>` against it — the duck addresses rooms by name, never by a remembered UUID.
    try {
      upsertChannels(routes, channels.map((c) => ({ id: c.id, name: c.name ?? c.id.slice(0, 8), trust: tierFor(c), configured: !!cfgFor(c) })))
    } catch (e) {
      log('channel index write failed:', (e as Error).message)
    }
    const unmatched = cfg.channels.filter((c) => !c.id && c.name && !channels.some((ch) => ch.name?.toLowerCase() === c.name!.toLowerCase()))
    if (unmatched.length) log(`config names the relay does not list (not a member yet?): ${unmatched.map((c) => c.name).join(', ')}`)
    const summary = channels.map((c) => `${c.name ?? c.id.slice(0, 8)}:${tierFor(c)}${cfgFor(c) ? '' : '?'}`).join(', ')
    if (summary !== lastSummary) log(`watching ${channels.length} channel(s): ${summary}`)
    lastSummary = summary
  }
}
let lastSummary = ''

async function post(ch: { id: string; name?: string }, ev: Ev, kind: 'mention' | 'reply_to_own' | 'message'): Promise<void> {
  const tier = tierFor(ch)
  const { spine, truncated, root } = buildSpine(ev)
  // ARMED THREAD? The duck may have told us (via ingress-arm-mcp → ingress-routes.sqlite) that replies in
  // this thread are follow-ups on a task: open them with a stance (`entry_hint`, resolved by the harness
  // against the duty's own `entries:` allowlist — never a route, never a trust change) and tag them so the
  // whole exchange lands under one runlog tag. Lookup is by thread ROOT, so every reply in the thread
  // inherits the arm, not just direct replies to our post.
  const arm = lookupArm(routes, root)
  // AMBIENT? Overheard traffic in a `wake:'all'` room — not addressed to the duck, not a reply to it, not in
  // a thread it armed — goes to the channel's `ambient_path` (when configured), keyed per CHANNEL so the
  // harness folds the whole room into one slow batch; no spine (a digest reads items, the duck can
  // `messages thread` anything it wants to see in full). Everything else stays per-thread on `/buzz/<tier>`.
  const ambientPath = kind === 'message' && !arm ? cfgFor(ch)?.ambient_path : undefined
  const ambient = !!ambientPath
  const attachments = parseImeta(ev) // P0: media awareness — metadata for every attachment (all mimes)
  const media = ambient ? [] : prefetchMedia(attachments) // P2: passively fetched thumb(s)/image(s) the duck SEES on wake
  if (!ambient) prefetchDocsInto(attachments, ch.name) // fetch non-image docs into the workspace inbox → stamp `file` (a workspace path)
  const body = {
    channel: { id: ch.id, name: ch.name ?? null },
    trigger: kind,
    ...(ambient ? { ambient: true } : {}),
    event_id: ev.id,
    root,
    from: { pubkey: ev.pubkey, name: resolveName(ev.pubkey) },
    content: ev.content,
    // Media the trigger message carries (imeta): the duck perceives it exists (mime/dim/size/filename). Only
    // present when the message has attachments, so non-media wakes are byte-for-byte unchanged.
    ...(attachments.length ? { attachments } : {}),
    // P2: prefetched image files (thumbs) on disk in the harness media dir — the engine confines + carries
    // these onto the Perceive goal turn so the duck SEES them. Absent unless `media_prefetch` is enabled.
    ...(media.length ? { media } : {}),
    // The ancestor spine (root → … → trigger); `truncated` ⇒ a deeper middle the duck can `thread_get`.
    // An ambient item carries NO spine (keeps a 30-minute room batch small; `root` is there to fetch it).
    spine: ambient ? [] : spine,
    truncated: ambient ? false : truncated,
    // ADAPTER-AGNOSTIC reply routing as TOP-LEVEL scalars — the harness's reply-scope reads top-level
    // scalar fields (same source as scope_env) and injects them into a reply skill's `ref` args, so the duck
    // writes only the content and the harness destination-locks the target. Slack/Discord adapters fill the
    // same two: `conversation` = where to reply, `in_reply_to` = the message to thread under.
    conversation: ch.id,
    in_reply_to: ev.id,
    created_at: ev.created_at,
    // Per-thread key: coalescing + sticky session fold a thread's activity into one wake. Ambient traffic is
    // keyed per CHANNEL instead, so the whole room folds into the slow batch behind `ambient_path`.
    dedup_key: ambient ? `buzz:chan:${ch.id}` : `buzz:${root}`,
    ...(arm ? { entry_hint: arm.entry_hint, tags: arm.tags, armed: { by: arm.armed_by.slice(0, 8), expires_at: arm.expires_at } } : {}),
  }
  const path = ambientPath ?? `/buzz/${tier}`
  try {
    const r = await fetch(`${cfg.harness_webhook}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    log(`${ambient ? 'ambient' : kind} in ${ch.name ?? ch.id.slice(0, 8)} from ${ev.pubkey.slice(0, 8)} → ${path}${arm ? ` [armed:${arm.entry_hint} ${arm.tags.join(',')}]` : ''} (${r.status})`)
  } catch (e) {
    log('forward failed:', e)
  }
}

async function pollChannel(ch: { id: string; name?: string }): Promise<void> {
  const first = cursor[ch.id] === undefined
  const since = first ? Math.floor(Date.now() / 1000) - cfg.first_run_lookback_secs : cursor[ch.id]
  const evs: Ev[] = buzz(['messages', 'get', '--channel', ch.id, '--since', String(since)]) ?? []
  if (!Array.isArray(evs)) return
  // Oldest → newest so a thread's cursor advances monotonically.
  evs.sort((a, b) => a.created_at - b.created_at)
  for (const ev of evs) {
    if (ev.created_at > (cursor[ch.id] ?? 0)) cursor[ch.id] = ev.created_at
    if (ev.pubkey === cfg.self_pubkey) {
      rememberOwn(ev.id) // track our own posts so replies to them wake us
      continue
    }
    if (seen.has(ev.id)) continue
    const isMention = cfg.wake_on.includes('mention') && pTags(ev).includes(cfg.self_pubkey)
    const isReply = cfg.wake_on.includes('reply_to_own') && eRefs(ev).some((r) => ownIds.has(r.id))
    // Per-channel 'all': in an org room every message by someone else is delivered (coalesce folds a
    // burst into one wake). The prompt's lane rule decides whether to ANSWER; the ingress only ensures
    // the duck SEES it — a peer's untagged question used to be invisible here.
    const isAll = cfgFor(ch)?.wake === 'all'
    if (isMention || isReply || isAll) {
      seen.add(ev.id)
      await post(ch, ev, isMention ? 'mention' : isReply ? 'reply_to_own' : 'message')
    }
  }
  saveCursor()
}

/** Poll the channel's REACTIONS (kind:7) into the shared store. Never a wake — a reaction is information the
 *  next wake reads off its spine / `own_replies` (a 👀 on your task post = acknowledged, don't ping for it).
 *  Own cursor key: a reaction's time must not move the message cursor. */
function pollReactions(ch: { id: string; name?: string }): void {
  const key = `${ch.id}:reactions`
  const first = cursor[key] === undefined
  const since = first ? Math.floor(Date.now() / 1000) - cfg.first_run_lookback_secs : cursor[key]
  const evs: Ev[] = buzz(['messages', 'get', '--channel', ch.id, '--since', String(since), '--kinds', '7']) ?? []
  if (!Array.isArray(evs) || !evs.length) return
  const rows = evs
    .filter((e) => e && e.kind === 7 && typeof e.id === 'string')
    .map((e) => ({ event_id: e.id, target_id: eRefs(e).at(-1)?.id ?? '', channel: ch.id, pubkey: e.pubkey, emoji: (e.content ?? '').trim(), created_at: e.created_at }))
    .filter((r) => r.target_id && r.emoji)
  try {
    const n = upsertReactions(routes, rows)
    if (n) log(`${n} reaction(s) in ${ch.name ?? ch.id.slice(0, 8)}: ${rows.slice(-n).map((r) => `${r.emoji} ${r.pubkey.slice(0, 8)}→${r.target_id.slice(0, 8)}`).join(', ')}`)
  } catch (e) {
    log('reactions write failed:', (e as Error).message)
  }
  for (const e of evs) if (e.created_at > (cursor[key] ?? 0)) cursor[key] = e.created_at
  saveCursor()
}

// ── main loop ────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`up — relay ${cfg.relay}, self ${cfg.self_pubkey.slice(0, 8)}, wake_on [${cfg.wake_on.join(',')}]`)
  discover()
  // Seed own-ids from recent history so a reply to an already-posted message wakes us.
  for (const ch of channels) {
    const evs: Ev[] = buzz(['messages', 'get', '--channel', ch.id, '--limit', '100']) ?? []
    for (const ev of Array.isArray(evs) ? evs : []) if (ev.pubkey === cfg.self_pubkey) rememberOwn(ev.id)
  }
  let sinceDiscover = 0
  let tick = 0
  for (;;) {
    if (sinceDiscover >= cfg.discover_interval_secs) {
      discover()
      sinceDiscover = 0
    }
    for (const ch of channels) await pollChannel(ch)
    // Reactions every 3rd tick (~30s): cheap awareness, never a wake.
    if (tick++ % 3 === 0) for (const ch of channels) pollReactions(ch)
    await new Promise((r) => setTimeout(r, cfg.poll_interval_secs * 1000))
    sinceDiscover += cfg.poll_interval_secs
  }
}

// Import for tests without starting the loop.
if (import.meta.main) {
  main().catch((e) => {
    log('fatal:', e)
    process.exit(1)
  })
}

export { buildSpine, eventById, rootOf, tierFor, parseImeta, prefetchMedia, type Ev }
