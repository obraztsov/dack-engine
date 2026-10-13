/**
 * Pure helpers for emoji reactions — shared by the `buzz-react` MCP and the ingress. No I/O.
 *
 * Why reactions: a teammate who has nothing to add does not write a paragraph, they react. Until now a
 * looper's only way to acknowledge a message was a reply, so it replied — restating, agreeing at length,
 * answering a status ping with a status ping. A reaction is the cheap "seen / on it / done / agreed" that
 * keeps a thread quiet without going dark. Jarvis already uses 👀 this way on the relay.
 */

/** A reaction's content: ONE emoji (a single pictographic grapheme, variation selectors / ZWJ sequences
 *  allowed) or a custom `:shortcode:`. Anything else — words, several emoji, an empty string — is refused:
 *  a reaction is a glyph, not a message. */
export function validateEmoji(raw: unknown): { ok: true; emoji: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: 'emoji must be a string' }
  const s = raw.trim()
  if (!s) return { ok: false, error: 'emoji is empty' }
  if (/^:[a-z0-9_+-]{1,32}:$/i.test(s)) return { ok: true, emoji: s }
  if (s.length > 16) return { ok: false, error: 'a reaction is ONE emoji, not text' }
  // One grapheme, every scalar in it pictographic or a modifier/joiner (skin tone, VS16, ZWJ, keycap, flags).
  const seg = typeof Intl !== 'undefined' && (Intl as any).Segmenter ? [...new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' }).segment(s)] : null
  if (seg && seg.length !== 1) return { ok: false, error: `a reaction is ONE emoji (got ${seg.length} characters)` }
  const ok = [...s].every((ch) => /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍️⃣]/u.test(ch))
  if (!ok || !/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)) return { ok: false, error: `"${s}" is not an emoji` }
  return { ok: true, emoji: s }
}

export const EVENT_ID_RE = /^[0-9a-f]{64}$/

/** Parse the CLI's `reactions get --event` output into rows (shape-tolerant: bare array or `{reactions:[…]}`). */
export function parseReactionsOut(out: string): { pubkey: string; emoji: string; created_at: number; id: string | null }[] {
  let j: any
  try {
    j = JSON.parse(out)
  } catch {
    return []
  }
  const arr: any[] = Array.isArray(j) ? j : Array.isArray(j?.reactions) ? j.reactions : []
  return arr
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      pubkey: String(r.pubkey ?? r.author ?? ''),
      emoji: String(r.content ?? r.emoji ?? ''),
      created_at: Number(r.created_at ?? 0),
      id: typeof r.id === 'string' ? r.id : null,
    }))
    .filter((r) => r.pubkey && r.emoji)
}
