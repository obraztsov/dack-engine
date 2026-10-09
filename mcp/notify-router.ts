/**
 * notify-router — ONE operational/error TRAIL (NOT a messaging lane). Everything a human must hear about
 * *going wrong* funnels here: harness terminal failures (engine `notify_url` hook), a swallowed-answer
 * detector, and model-initiated operational notes (the `notify` MCP). This is deliberately NOT how the
 * agent talks to people — a reply to a client or a heads-up to a group is a normal SEND (multi-baton
 * fan-out over telegram/buzz). This lane is the separate audit + alerting trail.
 *
 * POST /notify {severity: error|alert|info, source?, title?, body?, source_chat?} — producers POST;
 * CONNECTORS deliver. Generalized from the v0.1 (Nora) router: `severity_routes[sev] → [connector]` and
 * each connector carries its OWN targets (telegram chat_ids, buzz channels), so a severity can fan to
 * telegram AND a buzz ops-channel. `log` is jsonl-only (everything is logged regardless).
 *
 * Hygiene kept from v0.1's live-incident lessons: a dedup window (one brownout ≠ 50 identical pings); a
 * rolling hourly cap with a ONE-TIME "storm suppressed → log only" notice (silent suppression is how
 * operators stop trusting a lane); a jsonl audit of EVERY notification, delivered or not. Logs to stderr.
 */
import { appendFileSync, readFileSync, existsSync } from 'node:fs'

type Severity = 'error' | 'alert' | 'info'
type Notification = { severity: Severity; source?: string; title?: string; body?: string; source_chat?: string | null }

interface Cfg {
  listen: string
  // severity → connector names that deliver it. `log` = jsonl-only (always logged anyway).
  severity_routes: Record<string, string[]>
  telegram: { chat_ids: number[] }
  buzz: { channels: string[]; relay?: string } // delivered via the buzz CLI (BUZZ_BIN + buzz_key secret)
  dedup_window_sec: number
  hourly_cap: number
  audit_jsonl: string
}
const DEF: Cfg = {
  listen: '127.0.0.1:8794',
  severity_routes: { error: ['telegram'], alert: ['telegram'], info: ['log'] },
  telegram: { chat_ids: [] },
  buzz: { channels: [] },
  dedup_window_sec: 600,
  hourly_cap: 20,
  audit_jsonl: 'notify-audit.jsonl',
}

function loadCfg(): Cfg {
  const names = process.env.NOTIFY_CONFIG ? [process.env.NOTIFY_CONFIG] : ['notify.config.json', 'config/notify.config.json']
  for (const name of names) {
    if (!existsSync(name)) continue
    try {
      const c = JSON.parse(readFileSync(name, 'utf8'))
      return { ...DEF, ...c, telegram: { ...DEF.telegram, ...c.telegram }, buzz: { ...DEF.buzz, ...c.buzz } }
    } catch (e) {
      log('bad notify config', name, e)
    }
  }
  log(`no config (${names.join(', ')}) — jsonl-only mode`)
  return DEF
}

const log = (...a: unknown[]) => console.error('[notify]', ...a)
const cfg = loadCfg()
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim()
const BUZZ_BIN = process.env.BUZZ_BIN ?? ''
const BUZZ_RELAY = cfg.buzz.relay ?? process.env.BUZZ_RELAY_URL ?? ''
const ICON: Record<Severity, string> = { error: '❌', alert: '⚠️', info: 'ℹ️' }

const recent = new Map<string, number>() // dedup: key → last-delivered epoch (seconds)
let hourWindow: number[] = [] // delivery timestamps for the rolling hourly cap
let stormNoticed = false

function render(n: Notification): string {
  return `${ICON[n.severity] ?? ''} ${n.title ?? n.severity}\n${n.body ?? ''}${n.source_chat ? `\nsource chat: ${n.source_chat}` : ''}${n.source ? `\n— ${n.source}` : ''}`
}

async function tgSend(chatId: number, text: string): Promise<boolean> {
  if (!TOKEN) return false
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10000),
    })
    if (!r.ok) log(`telegram ${chatId} → ${r.status}`)
    return r.ok
  } catch (e) {
    log('telegram send failed:', e)
    return false
  }
}

/** Post to a buzz channel via the buzz CLI (uses BUZZ_PRIVATE_KEY from the buzz_key secret). */
function buzzSend(channel: string, text: string): boolean {
  if (!BUZZ_BIN || !BUZZ_RELAY || !process.env.BUZZ_PRIVATE_KEY) return false
  const env: Record<string, string> = { BUZZ_PRIVATE_KEY: process.env.BUZZ_PRIVATE_KEY }
  for (const k of ['PATH', 'HOME', 'LANG']) if (process.env[k]) env[k] = process.env[k]!
  const proc = Bun.spawnSync([BUZZ_BIN, '--relay', BUZZ_RELAY, 'messages', 'send', '--channel', channel, '--content', text], { env, stdout: 'ignore', stderr: 'pipe' })
  if (proc.exitCode !== 0) log(`buzz ${channel.slice(0, 8)} → ${proc.stderr.toString().slice(0, 160)}`)
  return proc.exitCode === 0
}

/**
 * Dedup identity of a notification: the CLASS (severity + source + title), **not** the body.
 *
 * The body carries per-occurrence detail (a stimulus id, an error string). Including it made every
 * notification its own key, so the dedup window never collapsed anything — a duck stuck in a failing
 * loop paged the operator once per wake, forever. Producers therefore keep `title` stable for a
 * recurring condition (the duty/prompt that failed) and put the varying detail in `body`.
 */
export function dedupKey(n: Notification): string {
  return `${n.severity}|${n.source ?? ''}|${n.title ?? ''}`
}

async function deliver(n: Notification): Promise<{ delivered: boolean; suppressed?: string; via?: string[] }> {
  const now = Date.now() / 1000
  const connectors = cfg.severity_routes[n.severity] ?? ['log']
  const wire = connectors.filter((c) => c !== 'log') // 'log' is the jsonl (always written by the caller)
  if (wire.length === 0) return { delivered: false }

  const key = dedupKey(n)
  const last = recent.get(key)
  if (last && now - last < cfg.dedup_window_sec) return { delivered: false, suppressed: 'duplicate' }

  hourWindow = hourWindow.filter((t) => now - t < 3600)
  if (hourWindow.length >= cfg.hourly_cap) {
    if (!stormNoticed) {
      stormNoticed = true
      for (const id of cfg.telegram.chat_ids) await tgSend(id, `⚠️ notify storm: over ${cfg.hourly_cap}/h — further notifications go to the log only`)
    }
    return { delivered: false, suppressed: 'storm-cap' }
  }
  stormNoticed = false

  const text = render(n)
  const via: string[] = []
  let ok = false
  if (wire.includes('telegram')) for (const id of cfg.telegram.chat_ids) { const d = await tgSend(id, text); ok = d || ok; if (d) via.push(`telegram:${id}`) }
  if (wire.includes('buzz')) for (const ch of cfg.buzz.channels) { const d = buzzSend(ch, text); ok = d || ok; if (d) via.push(`buzz:${ch.slice(0, 8)}`) }
  if (ok) {
    recent.set(key, now)
    hourWindow.push(now)
  }
  return { delivered: ok, via }
}

function main(): void {
  Bun.serve({
    hostname: cfg.listen.split(':')[0],
    port: Number(cfg.listen.split(':')[1] ?? 8794),
    async fetch(req: Request) {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/health') return Response.json({ ok: true })
      if (req.method !== 'POST' || url.pathname !== '/notify') return new Response('not found', { status: 404 })
      let n: Notification
      try {
        n = (await req.json()) as Notification
      } catch {
        return new Response('bad json', { status: 400 })
      }
      if (!(['error', 'alert', 'info'] as string[]).includes(n.severity)) return new Response('bad severity', { status: 400 })
      const result = await deliver(n)
      try {
        appendFileSync(cfg.audit_jsonl, JSON.stringify({ at: Math.floor(Date.now() / 1000), ...n, ...result }) + '\n')
      } catch (e) {
        log('audit append failed:', e)
      }
      log(`${n.severity} "${n.title ?? ''}" → ${JSON.stringify(result)}`)
      return Response.json({ ok: true, ...result })
    },
  })
  log(`up on ${cfg.listen}; routes=${JSON.stringify(cfg.severity_routes)} telegram=${cfg.telegram.chat_ids.length} buzz=${cfg.buzz.channels.length} tg_token=${TOKEN ? 'on' : 'OFF'} buzz_bin=${BUZZ_BIN ? 'on' : 'OFF'}`)
}

if (import.meta.main) main()

export { deliver, render, loadCfg, DEF }
