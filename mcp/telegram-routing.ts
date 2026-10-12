/**
 * Pure Telegram ingress policy — routing precedence and reply attribution — kept out of
 * `telegram-ingress.ts` (which starts the bot on import) so both are unit-tested.
 *
 * REPLY ATTRIBUTION (2026-10-12): the ingress forwarded a group message with no trace of whom it answered,
 * so every reply in a busy public room looked like it might be aimed at the duck — and the ducks kept
 * joining other people's exchanges ("if it's not about you, you really don't need to say anything bro").
 * Telegram puts the replied-to message INSIDE the update (`reply_to_message`, one hop: its author + text),
 * so the target is known without any mirror or fetch: `in_reply_to` (the parent id — the same adapter-
 * agnostic field the Buzz payload carries) + `reply_to` (who wrote the parent, whether that was US, and a
 * clip of what it said). Deeper chains are not in the update; that would need a message mirror.
 */

export type RouteCfg = {
  operator_ids?: number[]
  operator_user_id: number | null
  op_path: string
  pub_path: string
  groups: Record<string, string>
  dm_path?: string
  group_path?: string
}

export function opIds(cfg: RouteCfg): number[] {
  return cfg.operator_ids?.length ? cfg.operator_ids : cfg.operator_user_id != null ? [cfg.operator_user_id] : []
}

/**
 * Resolve a message's webhook path by precedence: configured group → operator → chat-type split → public.
 *
 * A CONFIGURED GROUP wins over the operator id: the operator talking inside the fleet group is group
 * context (the room sees it, the reply goes to the room), not an operator instruction — routing it to the
 * operator path woke both ducks on every line the operator exchanged with a third party there (18 silent-
 * cycle alerts in one hour, 2026-10-12). Operator DMs and unconfigured chats still take the operator path.
 */
export function routeFor(cfg: RouteCfg, fromId: number | null, chatId: number, chatType: string): { path: string; why: string } {
  const group = cfg.groups[String(chatId)]
  if (group) return { path: group, why: `group→${group}` }
  if (fromId != null && opIds(cfg).includes(fromId)) return { path: cfg.op_path, why: 'OP→org' }
  // OPT-IN chat-type split (unset → falls through to pub_path, the current single-webhook behavior).
  if (chatType === 'private' && cfg.dm_path) return { path: cfg.dm_path, why: 'dm' }
  if (chatType !== 'private' && cfg.group_path) return { path: cfg.group_path, why: 'group' }
  return { path: cfg.pub_path, why: 'pub' }
}

export type ReplyMeta = {
  in_reply_to: number
  reply_to: { message_id: number; from_user_id: number | null; from_username: string | null; is_self: boolean; text: string }
}

/** The reply target of a Telegram message, from the parent Telegram embeds in the update; null when not a reply. */
export function replyMeta(m: any, selfId: number | null | undefined): ReplyMeta | null {
  const p = m?.reply_to_message
  if (!p || typeof p.message_id !== 'number') return null
  const from = p.from ?? p.sender_chat ?? null
  const text: string = p.text ?? p.caption ?? (p.photo ? '[photo]' : p.document ? '[file]' : p.voice ? '[voice]' : '')
  return {
    in_reply_to: p.message_id,
    reply_to: {
      message_id: p.message_id,
      from_user_id: typeof from?.id === 'number' ? from.id : null,
      from_username: from?.username ?? null,
      is_self: selfId != null && from?.id === selfId,
      text: text.length > 200 ? text.slice(0, 199) + '…' : text,
    },
  }
}
