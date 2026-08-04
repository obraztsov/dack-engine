/**
 * Ingress SQLite store — the telegram-ingress adapter's own durable state (separate from the harness
 * `dack.sqlite`). Lives in the `/duck` volume so it's part of a duck's migration/backup set. Today it
 * holds per-chat ATTACHMENT permissions; it's the shared table the (future) telegram MCP writes to when
 * the duck enables attachments for a specific chat (e.g. a public contact who became a client).
 *
 * Uses Bun's built-in `bun:sqlite` (no dependency), WAL mode so the ingress (reader, per message) and a
 * future MCP writer can share it.
 */
import { Database } from 'bun:sqlite'

export type AttachKind = 'operator' | 'trusted' | 'dm' | 'group' | 'pub'
export type AttachDefaults = Partial<Record<AttachKind, boolean>>

// Conservative defaults: DM + operator + vetted (trusted/org) groups ON; open groups + broadcast channels
// OFF — so we never spend vision tokens on public contacts until the duck explicitly enables one (a
// per-chat override row, authored via the telegram MCP once that lands).
export const ATTACH_DEFAULTS: Record<AttachKind, boolean> = {
  operator: true,
  trusted: true,
  dm: true,
  group: false,
  pub: false,
}

/** Open (creating if needed) the ingress store + its schema. `:memory:` is accepted for tests. */
export function openIngressStore(path: string): Database {
  const db = new Database(path)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec(
    'CREATE TABLE IF NOT EXISTS chat_attachments (chat_id TEXT PRIMARY KEY, allowed INTEGER NOT NULL, updated_at INTEGER)',
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

/** Are attachments allowed for this chat? A per-chat override row wins; else the config default for the
 *  kind; else the built-in default. */
export function attachmentsAllowed(
  db: Database,
  defaults: AttachDefaults,
  chatId: string,
  kind: AttachKind,
): boolean {
  const row = db.query('SELECT allowed FROM chat_attachments WHERE chat_id = ?').get(chatId) as
    | { allowed: number }
    | null
  if (row) return !!row.allowed
  return defaults[kind] ?? ATTACH_DEFAULTS[kind]
}
