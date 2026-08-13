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
 *
 * P0 (this file): discover + poll + detect + POST (wake & reply). Thread-spine context is P1.
 * BUZZ_PRIVATE_KEY is injected by the module's `buzz_key` secret; never logged.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// ── config ───────────────────────────────────────────────────────────────────────────────────────

interface ChannelCfg {
  id: string
  name?: string
  trust?: string // override
}
interface Config {
  relay: string
  buzz_bin: string
  self_pubkey: string
  harness_webhook: string // e.g. http://127.0.0.1:8799
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
}

const DEFAULTS: Config = {
  relay: 'http://localhost:3000',
  buzz_bin: 'skills/buzz/bin/buzz',
  self_pubkey: '',
  harness_webhook: 'http://127.0.0.1:8787',
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

type SpineEv = { id: string; from: string; from_name: string; content: string; created_at: number }
const compactEv = (e: Ev): SpineEv => ({ id: e.id, from: e.pubkey, from_name: resolveName(e.pubkey), content: e.content, created_at: e.created_at })

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

function tierFor(ch: { id: string; name?: string }): string {
  const ov = cfg.channels.find((c) => c.id === ch.id)?.trust
  if (ov) return ov
  return (ch.name ?? '').toLowerCase() === 'dm' ? cfg.dm_default_trust : cfg.default_trust
}

// ── discovery + poll ────────────────────────────────────────────────────────────────────────────────

let channels: { id: string; name?: string }[] = []
function discover(): void {
  const list = buzz(['channels', 'list'])
  if (Array.isArray(list)) {
    channels = list.map((c: any) => ({ id: c.channel_id, name: c.name }))
    log(`watching ${channels.length} channel(s): ${channels.map((c) => c.name ?? c.id.slice(0, 8)).join(', ')}`)
  }
}

async function post(ch: { id: string; name?: string }, ev: Ev, kind: 'mention' | 'reply_to_own'): Promise<void> {
  const tier = tierFor(ch)
  const { spine, truncated, root } = buildSpine(ev)
  const body = {
    channel: { id: ch.id, name: ch.name ?? null },
    trigger: kind,
    event_id: ev.id,
    root,
    from: { pubkey: ev.pubkey, name: resolveName(ev.pubkey) },
    content: ev.content,
    // The ancestor spine (root → … → trigger); `truncated` ⇒ a deeper middle the duck can `thread_get`.
    spine,
    truncated,
    // ADAPTER-AGNOSTIC reply routing as TOP-LEVEL scalars — the harness's reply-scope reads top-level
    // scalar fields (same source as scope_env) and injects them into a reply skill's `ref` args, so the duck
    // writes only the content and the harness destination-locks the target. Slack/Discord adapters fill the
    // same two: `conversation` = where to reply, `in_reply_to` = the message to thread under.
    conversation: ch.id,
    in_reply_to: ev.id,
    created_at: ev.created_at,
    // Per-thread key: coalescing + sticky session fold a thread's activity into one wake.
    dedup_key: `buzz:${root}`,
  }
  try {
    const r = await fetch(`${cfg.harness_webhook}/buzz/${tier}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    log(`${kind} in ${ch.name ?? ch.id.slice(0, 8)} from ${ev.pubkey.slice(0, 8)} → /buzz/${tier} (${r.status})`)
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
    if (isMention || isReply) {
      seen.add(ev.id)
      await post(ch, ev, isMention ? 'mention' : 'reply_to_own')
    }
  }
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
  for (;;) {
    if (sinceDiscover >= cfg.discover_interval_secs) {
      discover()
      sinceDiscover = 0
    }
    for (const ch of channels) await pollChannel(ch)
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

export { buildSpine, eventById, rootOf, tierFor, type Ev }
