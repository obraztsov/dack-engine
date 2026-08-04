/**
 * Ingress SQLite store — the telegram-ingress adapter's own durable state (separate from the harness
 * `dack.sqlite`). Lives in the `/duck` volume so it's part of a duck's migration/backup set. Holds:
 *   - per-chat, PER-MEDIA attachment permissions (`image` and `voice` are gated SEPARATELY, for
 *     granularity — a chat may be allowed screenshots but not voice, or vice-versa);
 *   - per-user/day voice-transcription usage (the ASR abuse cap).
 * It's the shared table the telegram MCP `set_chat_attachments` tool writes to.
 *
 * Uses Bun's built-in `bun:sqlite` (no dependency), WAL mode so the ingress (reader) and an MCP writer
 * can share it.
 */
import { Database } from 'bun:sqlite'

export type MediaType = 'image' | 'voice'
export type AttachKind = 'operator' | 'trusted' | 'dm' | 'group' | 'pub'
export type AttachDefaults = Partial<Record<MediaType, Partial<Record<AttachKind, boolean>>>>

// Conservative defaults per media type: DM + operator + vetted (trusted/org) chats ON; open groups +
// broadcast channels OFF — so we never spend vision/ASR tokens on public contacts until the duck
// explicitly enables one (a per-chat override authored via the telegram MCP).
export const ATTACH_DEFAULTS: Record<MediaType, Record<AttachKind, boolean>> = {
  image: { operator: true, trusted: true, dm: true, group: false, pub: false },
  voice: { operator: true, trusted: true, dm: true, group: false, pub: false },
}

/** Open (creating if needed) the ingress store + its schema. `:memory:` is accepted for tests. */
export function openIngressStore(path: string): Database {
  const db = new Database(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec(
    'CREATE TABLE IF NOT EXISTS chat_attachments ' +
      '(chat_id TEXT NOT NULL, media TEXT NOT NULL, allowed INTEGER NOT NULL, updated_at INTEGER, ' +
      'PRIMARY KEY (chat_id, media))',
  )
  db.exec(
    'CREATE TABLE IF NOT EXISTS voice_usage ' +
      '(user_id TEXT NOT NULL, day TEXT NOT NULL, seconds INTEGER NOT NULL, PRIMARY KEY (user_id, day))',
  )
  return db
}

/**
 * The intrinsic attachment CATEGORY of a message — deliberately independent of the webhook-path routing
 * config, so a private chat is always `dm` (default-on) even when no `dm_path` is configured. Precedence:
 * operator > trusted group > private(`dm`) > broadcast channel(`pub`) > group/supergroup(`group`).
 */
export function attachmentKind(
  operatorId: number | null,
  groups: Record<string, string>,
  fromId: number | null,
  chatId: number,
  chatType: string,
): AttachKind {
  if (operatorId != null && fromId === operatorId) return 'operator'
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
