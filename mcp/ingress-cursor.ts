/**
 * ingress-cursor — the poll cursor + forwarded-id memory for a polling ingress (buzz-ingress).
 *
 * WHY a tolerance: the relay is queried with `--since <ts>` and `ts` used to be the newest `created_at` seen
 * on the channel. `created_at` is stamped by the SENDER's clock, so one peer with a slow clock (pond-jarvis
 * ran 15 s behind the host) publishes events that are already "older" than the cursor the moment one of OUR
 * posts (correct clock) advanced it — and they are never fetched (2026-10-19: Jarvis's approval request
 * d7a0c106 vanished behind the duck's own `/approve`; the command timed out unanswered). So the poll now
 * asks `since = cursor - clock_skew_tolerance_secs` and relies on a PERSISTED set of forwarded ids for
 * dedup, instead of trusting a monotonic timeline across clocks. The seen-set is pruned relative to the CURSOR
 * (an id is kept while a poll could still re-fetch it), never by wall-clock age.
 */

export interface CursorState {
  cursor: Record<string, number> // key (channel id, or `<id>:reactions`) → newest created_at seen
  seen: Map<string, number> // forwarded event id → its created_at (for pruning)
}

/** Parse the cursor file. Legacy shape `{<key>: <created_at>}` (numbers only) loads with an empty seen-set. */
export function parseCursorState(raw: string | undefined | null): CursorState {
  const empty: CursorState = { cursor: {}, seen: new Map() }
  if (!raw) return empty
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return empty
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
  const obj = parsed as Record<string, unknown>
  if (obj.cursor && typeof obj.cursor === 'object') {
    const cursor: Record<string, number> = {}
    for (const [k, v] of Object.entries(obj.cursor as Record<string, unknown>)) if (typeof v === 'number') cursor[k] = v
    const seen = new Map<string, number>()
    if (obj.seen && typeof obj.seen === 'object') {
      for (const [k, v] of Object.entries(obj.seen as Record<string, unknown>)) if (typeof v === 'number') seen.set(k, v)
    }
    return { cursor, seen }
  }
  // Legacy: a flat map of numbers.
  const cursor: Record<string, number> = {}
  for (const [k, v] of Object.entries(obj)) if (typeof v === 'number') cursor[k] = v
  return { cursor, seen: new Map() }
}

/** Prune the seen-set, then serialize. An id is still needed exactly while a poll can re-fetch it, i.e. while its
 *  `created_at >= cursor - tolerance` for its channel; without per-id channel info the floor is taken from the LOWEST
 *  message cursor (a quiet channel keeps a little more). NEVER prune by wall-clock age: after a restart with the
 *  cursor an hour old, an age-based prune forgot the replayed ids at once and re-forwarded them on every poll
 *  (2026-10-19 13:20Z). `maxIds` bounds the set (oldest dropped first). Mutates `state.seen`. */
export function serializeCursorState(state: CursorState, toleranceSecs: number, maxIds = 5000): string {
  const cursors = Object.entries(state.cursor)
    .filter(([k]) => !k.endsWith(':reactions'))
    .map(([, v]) => v)
  if (cursors.length) {
    const floor = Math.min(...cursors) - toleranceSecs - 60
    for (const [id, t] of state.seen) if (t < floor) state.seen.delete(id)
  }
  if (state.seen.size > maxIds) {
    const byAge = [...state.seen.entries()].sort((a, b) => a[1] - b[1])
    for (const [id] of byAge.slice(0, state.seen.size - maxIds)) state.seen.delete(id)
  }
  return JSON.stringify({ cursor: state.cursor, seen: Object.fromEntries(state.seen) })
}

/** The `--since` for a poll: first run looks back `firstRunLookbackSecs`; later runs re-read
 *  `toleranceSecs` behind the cursor so a slow-clocked peer's late-stamped events are still fetched. */
export function sinceFor(cursorVal: number | undefined, now: number, toleranceSecs: number, firstRunLookbackSecs: number): number {
  if (cursorVal === undefined) return now - firstRunLookbackSecs
  return Math.max(0, cursorVal - toleranceSecs)
}
