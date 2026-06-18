/**
 * Telegram INGRESS adapter (Phase 12.3) — the operator-owned, grammY-driven inbound side.
 *
 * It is NOT part of the Rust harness and the harness never parses Telegram. It long-polls the bot,
 * decides each message's TRUST by *who sent it* (its own config — chat/user → a harness webhook PATH),
 * and POSTs a normalized message to the harness's localhost webhook. The path's tier (the operator's
 * generic `config.webhooks:` map in dack.config.yaml) is what the duck's cycle gets seeded at — the
 * Rust core just sees "a localhost webhook fired at tier X." All Telegram specifics live here.
 *
 * Two tiers for now: the operator → `/telegram/op` (org); everyone else → `/telegram/pub` (public).
 * Run alongside `dack run`:  bun run openclaude-bridge/telegram-ingress.ts
 */
import { Bot } from 'grammy'
import { readFileSync } from 'node:fs'

function readFirst(paths: string[]): string | null {
  for (const p of paths) {
    try {
      return readFileSync(p, 'utf8')
    } catch {
      /* next */
    }
  }
  return null
}

function loadToken(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN ?? readFirst(['secrets/telegram.token', '../secrets/telegram.token'])
  if (!t) throw new Error('no TELEGRAM_BOT_TOKEN env and no secrets/telegram.token')
  return t.trim()
}

type Cfg = { harness_webhook: string; operator_user_id: number | null; op_path: string; pub_path: string }
function loadConfig(): Cfg {
  const def: Cfg = { harness_webhook: 'http://127.0.0.1:8787', operator_user_id: null, op_path: '/telegram/op', pub_path: '/telegram/pub' }
  const name = process.env.TELEGRAM_INGRESS_CONFIG ?? 'telegram-ingress.config.json'
  const raw = readFirst([name, `openclaude-bridge/${name}`, `../${name}`])
  return raw ? { ...def, ...JSON.parse(raw) } : def
}

const cfg = loadConfig()
const bot = new Bot(loadToken())

bot.on('message', async (ctx) => {
  const m = ctx.message
  const fromId = m.from?.id ?? null
  const isOp = cfg.operator_user_id != null && fromId === cfg.operator_user_id
  const path = isOp ? cfg.op_path : cfg.pub_path
  const body = {
    chat_id: m.chat.id,
    message_id: m.message_id,
    text: (m as any).text ?? (m as any).caption ?? '',
    from_username: m.from?.username ?? null,
    from_user_id: fromId,
    chat_type: m.chat.type,
    dedup_key: `${m.chat.id}:${m.message_id}`,
  }
  try {
    const r = await fetch(cfg.harness_webhook + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    console.error(`[tg-ingress] ${isOp ? 'OP→org' : 'pub'} msg ${m.message_id} from @${m.from?.username} chat ${m.chat.id} → ${path} (${r.status})`)
  } catch (e) {
    console.error('[tg-ingress] forward failed:', e)
  }
})

bot.catch((err) => console.error('[tg-ingress] bot error:', err?.error ?? err))
console.error(`[tg-ingress] long-polling; operator_user_id=${cfg.operator_user_id} → ${cfg.op_path}, else → ${cfg.pub_path}; harness=${cfg.harness_webhook}`)
bot.start()
