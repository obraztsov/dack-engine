/**
 * Telegram INGRESS adapter — the operator-owned, grammY-driven inbound side.
 *
 * It is NOT part of the Rust harness and the harness never parses Telegram. It long-polls the bot,
 * decides each message's TRUST by *who sent it* (its own config — chat/user → a harness webhook PATH),
 * and POSTs a normalized message to the harness's localhost webhook. The path's tier (the operator's
 * generic `config.webhooks:` map in dack.config.yaml) is what the duck's cycle gets seeded at — the
 * Rust core just sees "a localhost webhook fired at tier X." All Telegram specifics live here.
 *
 * Routing (who → which webhook PATH, by precedence):
 *   1. the operator's user_id (anywhere, even inside a public group) → `op_path` (org) — provenance
 *      follows the person, not the room.
 *   2. a known/trusted GROUP by chat_id (the `groups` map) → that group's configured path (e.g. a
 *      private team/investor group → an org path). All members of a trusted group inherit its tier.
 *   3. everyone else (strangers, public/trencher groups) → `pub_path` (public).
 * The PATH's tier lives in the harness `config.webhooks:` map — this adapter only assigns the path.
 * Run by the harness `modules:` supervisor (no manual start).
 */
import { Bot } from 'grammy'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import {
  openIngressStore,
  attachmentKind,
  attachmentsAllowed,
  voiceUsageToday,
  addVoiceUsage,
  voiceWithinCap,
  recordReferral,
  parseStartParam,
  type AttachDefaults,
  upsertChat,
  chatDisplayName,
} from './ingress-store'
import { routeFor, opIds, replyMeta } from './telegram-routing'

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

type Cfg = {
  harness_webhook: string
  // OPERATORS: `operator_ids` is the multi-operator list; `operator_user_id` is the legacy single field
  // (still honored). A sender in either → the operator route + operator attachment perms. Empty = none.
  operator_ids?: number[]
  operator_user_id: number | null
  op_path: string
  pub_path: string
  // Trusted/known groups: chat_id (as a string key) → the webhook path its members route to.
  groups: Record<string, string>
  // OPT-IN chat-type split (both fall back to `pub_path` when unset — so an existing single-webhook
  // config is unchanged). A non-operator PRIVATE chat → `dm_path` (e.g. the pond client/DM prompt); a
  // non-trusted GROUP/supergroup → `group_path`. Lets private clients and public groups get different
  // prompts + MCP sets while staying the same `public` tier.
  dm_path?: string
  group_path?: string
  // Harness-owned media dir (Phase 1: photos). Must match the harness `media_dir` (both cwd-relative,
  // same container /duck) so the harness resolves the filename this adapter writes. Default `media`.
  media_dir: string
  // ATTACHMENT permission defaults by chat kind (operator/trusted/dm/group/pub). Per-chat overrides live
  // in `ingress.sqlite`. Omit ⇒ the built-in defaults (DM/operator/trusted on, open groups/channels off).
  attachments?: AttachDefaults
  // The ingress SQLite store path (per-chat attachment overrides + future ingress state). In /duck.
  ingress_db: string
  // TYPING INDICATOR: poll the harness `GET /active-conversations` and send a Telegram `typing` chat
  // action for each conversation the duck is PROCESSING right now — so the indicator reflects real work
  // (it appears only after the coalesce window + queue, when a cycle actually starts), not mere receipt.
  // Omit ⇒ ON with defaults. `poll_secs` should stay ≤5 (Telegram clears typing after ~5s, so we re-send).
  // `dms_only` (default true) restricts it to private chats (positive chat_id) where the duck reliably
  // replies — in groups it's usually a silent guest, so typing would over-promise.
  typing_indicator?: {
    enabled?: boolean // default true
    poll_secs?: number // default 4 (clamped to ≥2)
    dms_only?: boolean // default true
  }
  // Voice transcription (Phase 2). SELF-CONTAINED here (own endpoint + key) so it can point at Xiaomi
  // ASR today or an OpenAI Whisper endpoint later, decoupled from the harness chat connector. Omit ⇒
  // voice is not transcribed. `api_key` may also come from env ASR_API_KEY. Transcript flows as text.
  asr?: {
    api_url: string // full chat/completions (or transcriptions) URL — e.g. https://api.xiaomimimo.com/v1/chat/completions
    api_key?: string // ASR key (reuse the Xiaomi key, or a separate one); env ASR_API_KEY overrides
    model?: string // default "mimo-v2.5-asr"
    language?: string // "auto" | "zh" | "en" (default "auto")
    daily_limit_secs?: number // per-USER daily audio cap (default 3600 = 1h); 0 disables voice
  }
}
function loadConfig(): Cfg {
  const def: Cfg = {
    harness_webhook: 'http://127.0.0.1:8787',
    operator_user_id: null,
    op_path: '/telegram/op',
    pub_path: '/telegram/pub',
    groups: {},
    media_dir: 'media',
    ingress_db: 'ingress.sqlite',
  }
  const name = process.env.TELEGRAM_INGRESS_CONFIG ?? 'telegram-ingress.config.json'
  const raw = readFirst([name, `mcp/${name}`, `../${name}`])
  return raw ? { ...def, ...JSON.parse(raw) } : def
}

/** The effective operator id set: the `operator_ids` list, else the legacy single `operator_user_id`. */
// Routing precedence (`routeFor`) + reply attribution (`replyMeta`) live in `telegram-routing.ts`, pure and
// unit-tested: a CONFIGURED GROUP wins over the operator id — the operator talking in the fleet group is
// group context, not an operator instruction.

const cfg = loadConfig()
const token = loadToken()
const bot = new Bot(token)
// The ingress's own SQLite store (per-chat attachment permissions; future ingress state). In /duck.
const store = openIngressStore(cfg.ingress_db)

// Telegram bot download ceiling (~20MB); MiMo also caps an image at 50MB. Oversized → skipped.
const MAX_MEDIA_BYTES = 20 * 1024 * 1024

/** Download the highest-resolution size of a photo message to the harness-owned media dir, returning the
 *  payload media ref (filename only — bytes never cross the webhook; the harness reads the file). Best-
 *  effort: any failure returns null and the message still forwards as text/caption. */
async function downloadPhoto(ctx: any, m: any): Promise<{ kind: string; file: string; mime: string } | null> {
  try {
    const sizes = m.photo as Array<{ file_id: string; file_unique_id: string; file_size?: number }>
    if (!sizes?.length) return null
    const largest = sizes[sizes.length - 1] // last entry = highest resolution
    if (largest.file_size && largest.file_size > MAX_MEDIA_BYTES) {
      console.error(`[tg-ingress] photo ${largest.file_unique_id} too large (${largest.file_size}b) — skipped`)
      return null
    }
    const file = await ctx.api.getFile(largest.file_id) // → { file_path }
    if (!file.file_path) return null
    const resp = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)
    if (!resp.ok) {
      console.error(`[tg-ingress] photo download HTTP ${resp.status}`)
      return null
    }
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length > MAX_MEDIA_BYTES) return null
    const ext = (file.file_path.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
    const name = `${m.chat.id}_${m.message_id}_${largest.file_unique_id}.${ext}`
    mkdirSync(cfg.media_dir, { recursive: true })
    writeFileSync(`${cfg.media_dir}/${name}`, buf)
    const mime =
      ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg'
    console.error(`[tg-ingress] stored photo ${name} (${buf.length}b) for msg ${m.message_id}`)
    return { kind: 'image', file: name, mime }
  } catch (e) {
    console.error('[tg-ingress] photo download failed:', e)
    return null
  }
}

/** Download a document/file message (`m.document` — a file sent via Telegram's "send as file": a PDF/docx/…
 *  OR an uncompressed image) to the harness media dir. Returns a stored-attachment ref (filename only — bytes
 *  never cross the webhook; the harness reads the file). Best-effort → null on failure. */
async function downloadDocument(doc: any, m: any): Promise<{ file: string; mime: string; filename: string; size: number; kind: string } | null> {
  try {
    if (doc.file_size && doc.file_size > MAX_MEDIA_BYTES) {
      console.error(`[tg-ingress] document ${doc.file_unique_id} too large (${doc.file_size}b) — skipped`)
      return null
    }
    const buf = await downloadFileBuffer(doc.file_id)
    if (!buf || buf.length > MAX_MEDIA_BYTES) return null
    const mime = String(doc.mime_type ?? 'application/octet-stream')
    const origName = String(doc.file_name ?? '')
    const ext = (origName.includes('.') ? origName.split('.').pop()! : 'bin').toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
    const name = `${m.chat.id}_${m.message_id}_${doc.file_unique_id}.${ext}`
    mkdirSync(cfg.media_dir, { recursive: true })
    writeFileSync(`${cfg.media_dir}/${name}`, buf)
    const kind = mime.startsWith('image/') ? 'image' : 'file'
    console.error(`[tg-ingress] stored ${kind} ${name} (${buf.length}b, ${mime}) for msg ${m.message_id}`)
    return { file: name, mime, filename: origName || name, size: buf.length, kind }
  } catch (e) {
    console.error('[tg-ingress] document download failed:', e)
    return null
  }
}

/** Download any Telegram file (by file_id) to a Buffer. Best-effort → null on failure. */
async function downloadFileBuffer(fileId: string): Promise<Buffer | null> {
  try {
    const file = await bot.api.getFile(fileId)
    if (!file.file_path) return null
    const resp = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`)
    if (!resp.ok) {
      console.error(`[tg-ingress] file download HTTP ${resp.status}`)
      return null
    }
    return Buffer.from(await resp.arrayBuffer())
  } catch (e) {
    console.error('[tg-ingress] file download failed:', e)
    return null
  }
}

/** Transcode Telegram voice (OGG/Opus) → mono 16 kHz mp3 (what MiMo ASR accepts) via ffmpeg. null on fail. */
async function transcodeToMp3(ogg: Buffer): Promise<Buffer | null> {
  try {
    const proc = Bun.spawn(
      ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 'mp3', 'pipe:1'],
      { stdin: ogg, stdout: 'pipe', stderr: 'pipe' },
    )
    const mp3 = Buffer.from(await new Response(proc.stdout).arrayBuffer())
    const code = await proc.exited
    if (code !== 0 || mp3.length === 0) {
      console.error(`[tg-ingress] ffmpeg failed (exit ${code}, ${mp3.length}b)`)
      return null
    }
    return mp3
  } catch (e) {
    console.error('[tg-ingress] ffmpeg spawn failed (is ffmpeg installed?):', e)
    return null
  }
}

/** Send mp3 to the configured ASR endpoint (input_audio content part) → transcript text, or null. */
async function transcribeVoice(mp3: Buffer): Promise<string | null> {
  const asr = cfg.asr
  const key = process.env.ASR_API_KEY ?? asr?.api_key
  if (!asr || !key) {
    console.error('[tg-ingress] ASR not configured (need cfg.asr + api_key/ASR_API_KEY)')
    return null
  }
  const b64 = mp3.toString('base64')
  if (b64.length > 10 * 1024 * 1024) {
    console.error('[tg-ingress] audio exceeds ASR 10MB base64 limit — skipped')
    return null
  }
  try {
    const resp = await fetch(asr.api_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: asr.model ?? 'mimo-v2.5-asr',
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: b64, format: 'mp3' } }] }],
        asr_options: { language: asr.language ?? 'auto' },
      }),
    })
    const j: any = await resp.json().catch(() => ({}))
    if (!resp.ok) {
      console.error(`[tg-ingress] ASR HTTP ${resp.status}: ${JSON.stringify(j).slice(0, 200)}`)
      return null
    }
    const t = j?.choices?.[0]?.message?.content
    return typeof t === 'string' ? t.trim() : null
  } catch (e) {
    console.error('[tg-ingress] ASR request failed:', e)
    return null
  }
}

/** Handle a voice message: gate (permission + daily cap) → download → transcode → transcribe. Returns the
 *  text to forward (the transcript, or a bracketed status note the duck can see + respond to). */
async function handleVoice(m: any, kind: ReturnType<typeof attachmentKind>, fromId: number | null): Promise<string> {
  const dur = m.voice?.duration ?? 0
  const chatId = String(m.chat.id)
  if (!attachmentsAllowed(store, cfg.attachments ?? {}, chatId, kind, 'voice'))
    return `[voice note, ${dur}s — voice transcription is not enabled for this chat]`
  if (!cfg.asr) return `[voice note, ${dur}s — no transcription configured]`
  const limit = cfg.asr.daily_limit_secs ?? 3600
  const userId = String(fromId ?? chatId)
  const day = new Date().toISOString().slice(0, 10) // UTC YYYY-MM-DD
  if (!voiceWithinCap(store, userId, day, dur, limit))
    return `[voice note, ${dur}s — daily voice limit reached (${voiceUsageToday(store, userId, day)}/${limit}s)]`
  const ogg = m.voice?.file_id ? await downloadFileBuffer(m.voice.file_id) : null
  if (!ogg) return `[voice note, ${dur}s — download failed]`
  const mp3 = await transcodeToMp3(ogg)
  if (!mp3) return `[voice note, ${dur}s — transcode failed]`
  const transcript = await transcribeVoice(mp3)
  if (transcript == null || transcript === '') return `[voice note, ${dur}s — transcription failed]`
  addVoiceUsage(store, userId, day, dur)
  console.error(`[tg-ingress] transcribed voice ${dur}s from ${chatId} → ${transcript.length} chars`)
  return transcript
}

bot.on('message', async (ctx) => {
  const m = ctx.message
  const fromId = m.from?.id ?? null
  const { path, why } = routeFor(cfg, fromId, m.chat.id, m.chat.type)
  // When the user ACTUALLY sent this message (Telegram `m.date`, unix seconds) → a readable UTC
  // string the model can compare against its `now` block. A coalesced wake keeps each message's
  // `sent_at` in `items[]`, so the model can tell messages that arrived WHILE it was thinking/replying
  // from genuine impatient repeats — and see the real gaps between them.
  const sent_at = m.date
    ? new Date(m.date * 1000).toISOString().replace('T', ' ').replace(/\..+Z$/, ' UTC')
    : null
  const kind = attachmentKind(opIds(cfg), cfg.groups, fromId, m.chat.id, m.chat.type)
  // IMAGE (Phase 1): download a photo to the harness media dir, but only if IMAGE attachments are enabled
  // for this chat (per-chat override in ingress.sqlite, else default by kind — DM/operator/trusted on,
  // open groups/channels off). The caption (if any) is captured as `text` below.
  const wantsPhoto = !!(m as any).photo
  const allowPhoto = wantsPhoto && attachmentsAllowed(store, cfg.attachments ?? {}, String(m.chat.id), kind, 'image')
  if (wantsPhoto && !allowPhoto)
    console.error(`[tg-ingress] photo from chat ${m.chat.id} (${kind}) — image attachments off, text only`)
  const media: Array<{ kind: string; file: string; mime: string }> = []
  if (allowPhoto) {
    const p = await downloadPhoto(ctx, m)
    if (p) media.push(p)
  }
  // DOCUMENT (sent "as a file" = `m.document`): a PDF/docx/… OR an uncompressed image. An image-as-file joins
  // the VISION lane (`media`, same as a photo — this is the "media works but files don't" operator fix); a
  // non-image document becomes an `attachments` entry — stored + surfaced to the duck (filename/mime/size)
  // for routing/sending, NOT loaded as a vision block (a document isn't one on the OpenAI-compat wire).
  const attachments: Array<{ file: string; mime: string; filename: string; size: number; kind: string }> = []
  const doc = (m as any).document
  if (doc) {
    const isImageDoc = String(doc.mime_type ?? '').startsWith('image/')
    const permKind = isImageDoc ? 'image' : 'file'
    if (attachmentsAllowed(store, cfg.attachments ?? {}, String(m.chat.id), kind, permKind as any)) {
      const got = await downloadDocument(doc, m)
      if (got) {
        if (isImageDoc) media.push({ kind: 'image', file: got.file, mime: got.mime })
        else attachments.push(got)
      }
    } else {
      console.error(`[tg-ingress] document from chat ${m.chat.id} (${kind}) — ${permKind} attachments off, text only`)
    }
  }
  // VOICE (Phase 2): a voice note → separately gated (VOICE attachments) + a per-user daily cap, then
  // downloaded, transcoded (ogg→mp3), and transcribed. The TRANSCRIPT becomes the message `text`, so it
  // flows downstream as an ordinary (untrusted, channel-tier) text message — no harness change.
  let text = (m as any).text ?? (m as any).caption ?? ''
  if ((m as any).voice) text = await handleVoice(m, kind, fromId)
  // REFERRAL (deep link): a `t.me/<bot>?start=<param>` link makes the client send `/start <param>` on first
  // open. Capture `param` against the referee (first-touch, immutable) so the duck can reward referrals in
  // token even if this first cycle fails — and surface it on the stimulus so the duck sees it immediately.
  const startParam = parseStartParam((m as any).text ?? '')
  if (startParam && fromId != null) {
    const ref = recordReferral(store, String(fromId), startParam, m.from?.username ?? null, String(m.chat.id))
    console.error(`[tg-ingress] referral param="${startParam}" from ${fromId} (@${m.from?.username ?? '?'}) seen#${ref.seen_count}`)
  }
  // Chat index: remember this chat's title / @username so the duck can address it by NAME (telegram-send).
  try {
    upsertChat(store, { chat_id: String(m.chat.id), type: m.chat.type, title: chatDisplayName(m.chat, m.from), username: m.chat.type === 'private' ? (m.from?.username ?? null) : ((m.chat as any).username ?? null) })
  } catch (e) {
    console.error('[tg-ingress] chat index write failed:', (e as Error).message)
  }
  // Reply attribution (from the parent Telegram embeds in the update — no mirror): `in_reply_to` + `reply_to`
  // {who wrote it, is_self, clip}. Absent on a non-reply, so every existing payload stays byte-identical.
  const reply = replyMeta(m, (ctx as any).me?.id ?? bot.botInfo?.id)
  const body = {
    chat_id: m.chat.id,
    message_id: m.message_id,
    text,
    ...(reply ?? {}),
    from_username: m.from?.username ?? null,
    from_user_id: fromId,
    chat_type: m.chat.type,
    // Forum "topics": the thread a message lives in, so a reply lands back in the SAME topic. Only for
    // real topic messages (not the auto reply-thread id); `null` elsewhere → the reply MCP omits it.
    message_thread_id: (m as any).is_topic_message ? ((m as any).message_thread_id ?? null) : null,
    sent_at,
    // Present only on a referral deep-link open → the duck can act on the ref immediately (else it can
    // pull it later via the telegram MCP `get_referral`). Absent on every ordinary message (back-compat).
    ...(startParam ? { start_param: startParam } : {}),
    // The THREAD key = the chat id (NOT per-message). The harness coalesces by this (a chat's
    // messages fold into one debounced wake) and keys the chat's sticky session on it. The
    // per-message id stays in `message_id` above (for reply-targeting + context).
    dedup_key: String(m.chat.id),
    // Present only for a photo / image-as-file message → keeps every existing text payload byte-identical
    // (back-compat). Images ride the VISION lane the harness already carries onto the model turn.
    ...(media.length ? { media } : {}),
    // Present only when a non-image document was sent "as a file": stored files the duck is AWARE of
    // (filename/mime/size) and can route/send — NOT loaded into the model as vision. Channel-agnostic shape
    // (buzz/email map to the same `attachments`). Outbound send-by-reference is a later slice.
    ...(attachments.length ? { attachments } : {}),
  }
  try {
    const r = await fetch(cfg.harness_webhook + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    console.error(`[tg-ingress] ${why} msg ${m.message_id} from @${m.from?.username} chat ${m.chat.id} (${m.chat.type}) → ${path} (${r.status})`)
  } catch (e) {
    console.error('[tg-ingress] forward failed:', e)
  }
})

/** Poll the harness for conversations being processed right now and keep a Telegram "typing…" indicator
 *  alive for each active DM. The indicator reflects REAL work: the harness only marks a conversation
 *  active once its cycle starts (after the coalesce window + queue), and the reply itself clears the
 *  indicator, so we just re-assert it every few seconds while the cycle runs. Best-effort: a momentarily
 *  unreachable harness (or an older build without the endpoint) simply skips the tick. */
function startTypingIndicator(): void {
  const tc = cfg.typing_indicator ?? {}
  if (tc.enabled === false) {
    console.error('[tg-ingress] typing indicator: disabled')
    return
  }
  const pollMs = Math.max(2, tc.poll_secs ?? 4) * 1000
  const dmsOnly = tc.dms_only !== false // default true
  const url = cfg.harness_webhook + '/active-conversations'
  let ticking = false
  setInterval(async () => {
    if (ticking) return // don't pile up if the harness is briefly slow
    ticking = true
    try {
      const r = await fetch(url).catch(() => null)
      if (!r || !r.ok) return
      const j: any = await r.json().catch(() => null)
      const list: Array<{ key: string; type: string }> = Array.isArray(j?.active) ? j.active : []
      const targets = list
        .filter((c) => c && c.type === 'telegram_message') // our channel only (not twitter/cron keys)
        .map((c) => Number(c.key))
        .filter((id) => Number.isFinite(id) && (!dmsOnly || id > 0)) // positive chat_id == a private DM
      // Fire all concurrently; a chat we can't act in (blocked/left) fails harmlessly and is ignored.
      await Promise.allSettled(targets.map((id) => bot.api.sendChatAction(id, 'typing')))
    } catch (e) {
      console.error('[tg-ingress] typing poll error:', e)
    } finally {
      ticking = false
    }
  }, pollMs)
  console.error(
    `[tg-ingress] typing indicator: ON (poll ${pollMs / 1000}s, ${dmsOnly ? 'DMs only' : 'all chats'}) → ${url}`,
  )
}
startTypingIndicator()

bot.catch((err) => console.error('[tg-ingress] bot error:', err?.error ?? err))
console.error(`[tg-ingress] long-polling; operators=${JSON.stringify(opIds(cfg))} → ${cfg.op_path}; trusted groups=${JSON.stringify(cfg.groups)}; else → ${cfg.pub_path}; harness=${cfg.harness_webhook}`)
bot.start()
