/**
 * Ingress SQLite store — the telegram-ingress adapter's own durable state (separate from the harness
 * `dack.sqlite`). Lives in the `/duck` volume so it's part of a duck's migration/backup set. Holds:
 *   - per-chat, PER-MEDIA attachment permissions (`image` and `voice` are gated SEPARATELY, for
 *     granularity — a chat may be allowed screenshots but not voice, or vice-versa);
 *   - per-user/day voice-transcription usage (the ASR abuse cap);
 *   - captured **deep-link referrals** (`t.me/<bot>?start=<param>` → a `/start <param>` message): the
 *     `param` (first-touch, e.g. a referrer's @username or a ref code) stored against the referee, so
 *     the duck can reward referrals in token later — retrievable via the telegram MCPs even if the
 *     first cycle failed to act on it, and markable `applied` for reward idempotency.
 *   - the **send audit** — one row per outbound send ATTEMPT (`reply` and `send_message`), success or
 *     failure. Ground truth for "did the reply land": the SDK swallows MCP-server stderr (so Bot API
 *     400/429s never reach docker logs) and the runlog under-records tool-path replies — this table
 *     is the only durable, queryable record of what was actually sent where.
 * It's the shared table the telegram MCP `set_chat_attachments` tool writes to.
 *
 * Uses Bun's built-in `bun:sqlite` (no dependency), WAL mode so the ingress (reader) and an MCP writer
 * can share it.
 */
import { Database } from 'bun:sqlite'

export type MediaType = 'image' | 'voice' | 'file'
export type AttachKind = 'operator' | 'trusted' | 'dm' | 'group' | 'pub'
export type AttachDefaults = Partial<Record<MediaType, Partial<Record<AttachKind, boolean>>>>

// Conservative defaults per media type: DM + operator + vetted (trusted/org) chats ON; open groups +
// broadcast channels OFF — so we never spend vision/ASR tokens on public contacts until the duck
// explicitly enables one (a per-chat override authored via the telegram MCP). `file` = a document/blob
// sent "as a file" (Telegram `m.document`: PDF/docx/… OR an uncompressed image) — stored + surfaced to the
// duck for routing, NOT auto-loaded into the model (a document isn't a vision block on the OpenAI-compat wire).
export const ATTACH_DEFAULTS: Record<MediaType, Record<AttachKind, boolean>> = {
  image: { operator: true, trusted: true, dm: true, group: false, pub: false },
  voice: { operator: true, trusted: true, dm: true, group: false, pub: false },
  file: { operator: true, trusted: true, dm: true, group: false, pub: false },
}

/** Open (creating if needed) the ingress store + its schema. `:memory:` is accepted for tests. */
export function openIngressStore(path: string): Database {
  const db = new Database(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  // Two processes write this file (the ingress module + an MCP tool). bun's default busy timeout is
  // 0, so a millisecond of overlap would throw "database is locked" instead of waiting.
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(
    'CREATE TABLE IF NOT EXISTS chat_attachments ' +
      '(chat_id TEXT NOT NULL, media TEXT NOT NULL, allowed INTEGER NOT NULL, updated_at INTEGER, ' +
      'PRIMARY KEY (chat_id, media))',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS voice_usage ' +
      '(user_id TEXT NOT NULL, day TEXT NOT NULL, seconds INTEGER NOT NULL, PRIMARY KEY (user_id, day))',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS referrals ' +
      '(user_id TEXT PRIMARY KEY, param TEXT NOT NULL, username TEXT, chat_id TEXT NOT NULL, ' +
      'created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, seen_count INTEGER NOT NULL DEFAULT 1, ' +
      'applied_at INTEGER)',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS send_audit ' +
      '(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, via TEXT NOT NULL, ' +
      'chat_id TEXT NOT NULL, ok INTEGER NOT NULL, message_id INTEGER, reply_to TEXT, ' +
      'chars INTEGER NOT NULL, error TEXT)',
  )
  db.exec('CREATE INDEX IF NOT EXISTS idx_send_audit_chat ON send_audit (chat_id, at)')
  // CHAT INDEX: every chat the bot has seen a message in (title / @username / type), upserted by the ingress,
  // so `telegram-send` can take a chat by NAME. An alias layer only — the destination allow-list still
  // decides what is sendable; a known title never grants reach.
  db.exec(
    'CREATE TABLE IF NOT EXISTS chats ' +
      '(chat_id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT, username TEXT, ' +
      'first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, msg_count INTEGER NOT NULL DEFAULT 0)',
  )
  return db
}

/**
 * The intrinsic attachment CATEGORY of a message — deliberately independent of the webhook-path routing
 * config, so a private chat is always `dm` (default-on) even when no `dm_path` is configured. Precedence:
 * operator > trusted group > private(`dm`) > broadcast channel(`pub`) > group/supergroup(`group`).
 */
export function attachmentKind(
  operatorIds: number[],
  groups: Record<string, string>,
  fromId: number | null,
  chatId: number,
  chatType: string,
): AttachKind {
  if (fromId != null && operatorIds.includes(fromId)) return 'operator'
  if (groups[String(chatId)]) return 'trusted'
  if (chatType === 'private') return 'dm'
  if (chatType === 'channel') return 'pub'
  return 'group'
}

/** Is `media` (image | voice) allowed for this chat? A per-chat/media override row wins; else the config
 *  default for (media, kind); else the built-in default. */
export function attachmentsAllowed(
  db: Database,
  defaults: AttachDefaults,
  chatId: string,
  kind: AttachKind,
  media: MediaType,
): boolean {
  const row = db.query('SELECT allowed FROM chat_attachments WHERE chat_id = ? AND media = ?').get(chatId, media) as
    | { allowed: number }
    | null
  if (row) return !!row.allowed
  return defaults[media]?.[kind] ?? ATTACH_DEFAULTS[media][kind]
}

/** Upsert a per-chat/media attachment override (the duck's `set_chat_attachments` authoring). */
export function setChatAttachment(
  db: Database,
  chatId: string,
  media: MediaType,
  allowed: boolean,
  now: number = Math.floor(Date.now() / 1000),
): void {
  db.query(
    'INSERT INTO chat_attachments (chat_id, media, allowed, updated_at) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(chat_id, media) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at',
  ).run(chatId, media, allowed ? 1 : 0, now)
}

/** The current per-chat/media override, or `null` if none (falls back to the kind default). */
export function getChatAttachment(db: Database, chatId: string, media: MediaType): boolean | null {
  const row = db.query('SELECT allowed FROM chat_attachments WHERE chat_id = ? AND media = ?').get(chatId, media) as
    | { allowed: number }
    | null
  return row ? !!row.allowed : null
}

// ── Voice usage cap (ASR abuse guard) ────────────────────────────────────────────────────────────

/** Seconds of voice this user has had transcribed on `day` (UTC `YYYY-MM-DD`). 0 if none. */
export function voiceUsageToday(db: Database, userId: string, day: string): number {
  const row = db.query('SELECT seconds FROM voice_usage WHERE user_id = ? AND day = ?').get(userId, day) as
    | { seconds: number }
    | null
  return row ? row.seconds : 0
}

/** Add `seconds` to a user's daily voice usage (upsert). */
export function addVoiceUsage(db: Database, userId: string, day: string, seconds: number): void {
  db.query(
    'INSERT INTO voice_usage (user_id, day, seconds) VALUES (?, ?, ?) ' +
      'ON CONFLICT(user_id, day) DO UPDATE SET seconds = seconds + excluded.seconds',
  ).run(userId, day, Math.max(0, Math.round(seconds)))
}

/** Would transcribing `durationSecs` more keep this user within `limitSecs` for the day? */
export function voiceWithinCap(
  db: Database,
  userId: string,
  day: string,
  durationSecs: number,
  limitSecs: number,
): boolean {
  if (limitSecs <= 0) return false // 0 ⇒ voice disabled
  return voiceUsageToday(db, userId, day) + Math.max(0, durationSecs) <= limitSecs
}

// ── Deep-link referrals (`t.me/<bot>?start=<param>`) ─────────────────────────────────────────────
// A user who opens the bot through a referral link sends a `/start <param>` message; the ingress
// captures `param` against that user (the referee). FIRST-TOUCH attribution: the first captured param
// is immutable (a later /start with a different link does NOT overwrite the referrer) — only the
// seen-count + last-seen advance. The duck reads these to reward referrals in token, and marks one
// `applied` once rewarded so it never double-pays across cycles/retries.

/** Extract a Telegram deep-link start parameter from a `/start <param>` message (also `/start@Bot <param>`).
 *  A `t.me/<bot>?start=<param>` link makes the client send exactly this on first open — trading bots use it
 *  for referral codes. Returns the param only if present AND within Telegram's deep-link charset
 *  (`[A-Za-z0-9_-]`, ≤64) — a bare `/start`, a non-start message, or an out-of-charset token yields null
 *  (the text is untrusted, so we accept only what a real deep link can actually produce). Pure (lives here,
 *  not in the ingress module, so it's importable without the ingress's bot-start side effects). */
export function parseStartParam(text: string): string | null {
  const m = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec((text ?? '').trim())
  const p = m?.[1]
  if (!p) return null
  return /^[A-Za-z0-9_-]{1,64}$/.test(p) ? p : null
}

export type Referral = {
  user_id: string
  param: string
  username: string | null
  chat_id: string
  created_at: number
  last_seen_at: number
  seen_count: number
  applied_at: number | null
}

/** Capture a `/start <param>` for `userId` (the referee). First-touch: the ORIGINAL `param`, `username`,
 *  and `created_at` are preserved on re-`/start`; only `seen_count` + `last_seen_at` advance. Returns the
 *  stored referral (the first-touch row, so a caller can tell a fresh capture from a repeat via
 *  `seen_count === 1`). */
export function recordReferral(
  db: Database,
  userId: string,
  param: string,
  username: string | null,
  chatId: string,
  now: number = Math.floor(Date.now() / 1000),
): Referral {
  db.query(
    'INSERT INTO referrals (user_id, param, username, chat_id, created_at, last_seen_at, seen_count) ' +
      'VALUES (?, ?, ?, ?, ?, ?, 1) ' +
      'ON CONFLICT(user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, seen_count = seen_count + 1',
  ).run(userId, param, username, chatId, now, now)
  return getReferral(db, userId) as Referral
}

/** The referral captured for `userId` (the referee), or `null` if that user never arrived via a link. */
export function getReferral(db: Database, userId: string): Referral | null {
  const row = db.query('SELECT * FROM referrals WHERE user_id = ?').get(userId) as Referral | null
  return row ?? null
}

/** Referrals not yet marked `applied`, oldest-first (the duck's reward queue). `limit` caps the batch. */
export function pendingReferrals(db: Database, limit = 50): Referral[] {
  return db
    .query('SELECT * FROM referrals WHERE applied_at IS NULL ORDER BY created_at ASC LIMIT ?')
    .all(Math.max(1, Math.min(500, limit))) as Referral[]
}

// ── Send audit (outbound delivery ground truth) ──────────────────────────────────────────────────
// Every outbound Telegram send ATTEMPT lands here — ok or failed, reply or proactive send — because
// nothing else records failures durably (MCP stderr is swallowed by the SDK; the model may shrug off
// an `ok:false` tool result). This is what a "did the duck's reply actually land?" investigation
// queries, and what a future delivery-health sensor can watch.

export type SendAudit = {
  id: number
  at: number
  /** Which egress path: `reply` (destination-locked) | `send_message` (privileged proactive). */
  via: string
  chat_id: string
  ok: number // 1 | 0 (sqlite boolean)
  message_id: number | null // Telegram's id of the delivered message (null on failure)
  reply_to: string | null // the message this was threaded to, when known
  chars: number // length of the text we tried to send
  error: string | null // failure detail (Bot API status+body slice, splice refusal, missing token…)
}

/** Record one send attempt. NEVER throws — auditing must not be able to break the send path itself
 *  (a failed insert logs to stderr and is dropped). */
export function recordSend(
  db: Database,
  a: { via: string; chatId: string; ok: boolean; messageId?: number | null; replyTo?: string | null; chars: number; error?: string | null },
  now: number = Math.floor(Date.now() / 1000),
): void {
  try {
    db.query(
      'INSERT INTO send_audit (at, via, chat_id, ok, message_id, reply_to, chars, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(now, a.via, a.chatId, a.ok ? 1 : 0, a.messageId ?? null, a.replyTo ?? null, a.chars, a.error?.slice(0, 500) ?? null)
  } catch (e) {
    console.error('[ingress-store] send_audit insert failed (send unaffected):', e)
  }
}

/** Recent send attempts, newest first — all chats, or one chat's. */
export function recentSends(db: Database, chatId: string | null = null, limit = 50): SendAudit[] {
  const cap = Math.max(1, Math.min(500, limit))
  return (
    chatId === null
      ? db.query('SELECT * FROM send_audit ORDER BY at DESC, id DESC LIMIT ?').all(cap)
      : db.query('SELECT * FROM send_audit WHERE chat_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(chatId, cap)
  ) as SendAudit[]
}

/** Mark `userId`'s referral rewarded (idempotent — only flips a still-pending row). Returns true if it
 *  transitioned pending→applied this call, false if there was no pending referral to apply. */
export function markReferralApplied(
  db: Database,
  userId: string,
  now: number = Math.floor(Date.now() / 1000),
): boolean {
  const res = db
    .query('UPDATE referrals SET applied_at = ? WHERE user_id = ? AND applied_at IS NULL')
    .run(now, userId)
  return res.changes > 0
}

// ── chat index ──────────────────────────────────────────────────────────────────────────────────────

export type ChatRow = { chat_id: string; type: string; title: string | null; username: string | null; first_seen_at: number; last_seen_at: number; msg_count: number }

/** A Telegram chat's display name: a group's title, or a private chat's @username / first name. */
export function chatDisplayName(chat: any, from?: any): string | null {
  if (chat?.title) return String(chat.title)
  if (chat?.type === 'private') return from?.username ? `@${from.username}` : [from?.first_name, from?.last_name].filter(Boolean).join(' ') || null
  return null
}

export function upsertChat(db: Database, c: { chat_id: string; type: string; title: string | null; username: string | null }, now = Math.floor(Date.now() / 1000)): void {
  db.query(
    'INSERT INTO chats (chat_id, type, title, username, first_seen_at, last_seen_at, msg_count) VALUES (?, ?, ?, ?, ?, ?, 1) ' +
      'ON CONFLICT(chat_id) DO UPDATE SET type = excluded.type, title = COALESCE(excluded.title, chats.title), ' +
      'username = COALESCE(excluded.username, chats.username), last_seen_at = excluded.last_seen_at, msg_count = chats.msg_count + 1',
  ).run(c.chat_id, c.type, c.title, c.username, now, now)
}

export function listChats(db: Database): ChatRow[] {
  return db.query('SELECT * FROM chats ORDER BY last_seen_at DESC').all() as ChatRow[]
}

/**
 * A chat by NAME: its title (groups) or `@username` (private chats / channels), case-insensitive, exact.
 * Ambiguous ⇒ refused (two groups titled "General"), unknown ⇒ null. Numeric ids are not resolved here.
 */
export function resolveChatByName(db: Database, ref: string): { ok: true; chat: ChatRow } | { ok: false; error: string } {
  const want = ref.trim().toLowerCase()
  const bare = want.replace(/^@/, '')
  const rows = listChats(db).filter((c) => (c.title ?? '').toLowerCase() === want || (c.username ?? '').toLowerCase() === bare)
  if (rows.length === 1) return { ok: true, chat: rows[0] }
  if (rows.length > 1) return { ok: false, error: `"${ref}" names ${rows.length} chats — use the chat_id` }
  return { ok: false, error: `no known chat named "${ref}"` }
}
