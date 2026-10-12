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
 * Resolve a message's webhook path: THE CHAT decides in a group, the SENDER only in a private chat.
 *
 * A group message routes by its group — a configured one to its path, any other to `group_path`/`pub_path`
 * — whoever wrote it, the operator included. The operator talking in a room is room context: the room
 * sees it, the reply goes to the room, and in a PUBLIC room the words are public-tier (operator decision
 * 2026-10-12: "I'm ok with the trust semantic of a public group being a public group — it's even ok for
 * me to larp there"). Routing the operator's lines to the operator path instead woke both ducks on every
 * exchange with a third party (18 silent-cycle alerts in one hour) and made a public room an org-trust
 * surface. Operator authority travels through DMs and the configured fleet group. The duck still SEES who
 * wrote it (`from_username`) — only the trust/entry comes from the chat.
 */
export function routeFor(cfg: RouteCfg, fromId: number | null, chatId: number, chatType: string): { path: string; why: string } {
  if (chatType !== 'private') {
    const group = cfg.groups[String(chatId)]
    if (group) return { path: group, why: `group→${group}` }
    return cfg.group_path ? { path: cfg.group_path, why: 'group' } : { path: cfg.pub_path, why: 'pub' }
  }
  if (fromId != null && opIds(cfg).includes(fromId)) return { path: cfg.op_path, why: 'OP→org' }
  // OPT-IN DM split (unset → pub_path, the single-webhook behavior).
  if (cfg.dm_path) return { path: cfg.dm_path, why: 'dm' }
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
