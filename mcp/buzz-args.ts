/**
 * Pure argv policy for the generic `buzz` CLI wrapper MCP — the two fail-closed gates applied before we
 * ever spawn the binary. Kept in its own module (no I/O) so both are unit-testable: they are the whole
 * security boundary of a tool that otherwise hands the model a real CLI.
 */

/** Irreversible / admin verbs a chatting agent should not casually run. Matched against the first
 *  positional and the first-two ("verb subverb"). Operator override: BUZZ_CLI_DENY="" allows everything. */
export const DEFAULT_DENY = [
  'agents', 'workflows', // identity + automation admin — never an agent's business
  'messages delete', 'messages edit',
  // Channels are the org's ROOMS: creating/renaming/deleting them is an operator act (a project binds to
  // an EXISTING channel, and `projects add-channel` drafts for owner review anyway). Joining is fine.
  'channels create', 'channels update', 'channels delete', 'channels leave',
  // `projects` + `repos` are otherwise OPEN (operator decision 2026-10-08): an agent may create a project,
  // announce/bind a repo, file + triage issues, and open patches/PRs — that is the point of giving a fleet
  // a git workspace. Only the irreversible tombstone stays out of reach.
  'projects delete',
  'moderation', // banning/timing-out members is an operator act
]

/**
 * Flags that take NO value, so the token after them is a real positional. Everything else is assumed to
 * take a value — the safe default here, because mistaking a value-taking flag for a boolean would let its
 * VALUE be read as a verb (a false positive), while the reverse only costs an extra candidate list below.
 * Derived from `buzz <verb> --help`; re-check on CLI upgrades.
 */
const BOOLEAN_FLAGS = new Set(['-h', '--help', '--broadcast', '--member'])

/** Positional path with flag arity accounted for: `["--format","json","messages","edit"]` → `["messages","edit"]`. */
function positionalsAritySafe(args: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('-')) {
      out.push(a)
      continue
    }
    if (a.includes('=')) continue // `--flag=value` carries its own value
    if (!BOOLEAN_FLAGS.has(a)) i++ // consume the next token as this flag's value
  }
  return out
}

/**
 * Returns the matched denied verb, or null.
 *
 * Checks TWO candidate paths and denies if EITHER matches, because neither alone is safe:
 *   - **arity-aware** — required, else a flag's VALUE shifts the path and the deny-list is trivially
 *     bypassed: `["--format","json","messages","delete"]` naively reads as verb `json`, so
 *     `messages delete` would sail through. (This was a live bypass; see the regression test.)
 *   - **naive** (drop every flag-shaped token) — kept as a backstop for a value-less flag we don't know
 *     about yet: arity-aware would wrongly eat the verb after it, and this path still sees it.
 * Union ⇒ a new flag can cost an extra refusal, never a silent bypass. Fail-closed by construction.
 */
export function deniedVerb(args: string[], deny: string[]): string | null {
  for (const verbs of [positionalsAritySafe(args), args.filter((a) => !a.startsWith('-'))]) {
    const one = (verbs[0] || '').toLowerCase()
    const two = `${one} ${(verbs[1] || '').toLowerCase()}`.trim()
    const hit = deny.find((d) => d === one || d === two)
    if (hit) return hit
  }
  return null
}

/**
 * Flags that would turn this thin wrapper into an arbitrary host-filesystem primitive. Both are legitimate
 * CLI features, but as free-form argv they bypass every confinement the harness has:
 *   - `--file <p>`  (messages send) READS any path this process can see and UPLOADS it to the relay — i.e.
 *                   `--file /duck/identities/soul` would publish the duck's signing key. Exfiltration.
 *   - `-o/--output` (media get) WRITES to any path — clobbering a soul file, a config, or a secret.
 *
 * Each keeps its capability through a dedicated CONFINED tool (`send_file` / `media_fetch`) that routes the
 * path through the attachment store, so only the unconfined SHAPE is refused.
 *
 * `-f` is listed pre-emptively: today's CLI has no `-f` alias (only `-o, --output` exists as a short form),
 * but clap derives short flags readily and a future `--file`/`-f` pairing must not open the hole silently.
 * The asymmetry justifies it — a false positive costs one tool call that names the right tool, a false
 * negative costs key exfiltration. Re-check on CLI upgrades (`buzz <verb> --help`).
 */
export const HOST_PATH_FLAGS: Record<string, string> = {
  '--file': 'send_file',
  '-f': 'send_file',
  '--patch-file': 'send_file',
  '--body-file': 'send_file',
  '--output': 'media_fetch',
  '-o': 'media_fetch',
}

/** Host-path flags that READ a file to publish it. With a workspace, their value is CONFINED (resolved inside
 *  `WORKSPACE_DIR`, else refused) instead of the flag being refused outright. `--output`/`-o` (a WRITE) stays
 *  refused — `media_fetch` owns the only write path. */
export const WORKSPACE_READ_FLAGS = new Set(['--file', '-f', '--patch-file', '--body-file'])

export type ConfinedArgs = { ok: true; args: string[]; files: string[] } | { ok: false; error: string }

/**
 * Rewrite every workspace-read flag value (`--file x`, `--file=x`, repeated) through `resolve` — a workspace
 * path becomes its real absolute path, anything else refuses the WHOLE command (nothing is sent). A write
 * flag (`--output`/`-o`) refuses as before. Pure over `resolve`, tested without a filesystem.
 */
export function confineHostPathFlags(
  args: string[],
  resolve: (ref: string) => { path: string } | { error: string },
): ConfinedArgs {
  const out: string[] = []
  const files: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const eq = a.startsWith('--') ? a.indexOf('=') : -1
    const bare = eq > 0 ? a.slice(0, eq) : a
    if (!(bare in HOST_PATH_FLAGS)) { out.push(a); continue }
    if (!WORKSPACE_READ_FLAGS.has(bare)) {
      return { ok: false, error: `"${bare}" writes to a host path and is not allowed here — use the \`${HOST_PATH_FLAGS[bare]}\` tool. (Nothing was sent.)` }
    }
    const ref = eq > 0 ? a.slice(eq + 1) : args[i + 1]
    if (ref === undefined) { out.push(a); continue }
    const r = resolve(ref)
    if ('error' in r) return { ok: false, error: `${bare}: ${r.error} (nothing was sent)` }
    files.push(r.path)
    if (eq > 0) out.push(`${bare}=${r.path}`)
    else { out.push(bare, r.path); i++ }
  }
  return { ok: true, args: out, files }
}

/** Read a flag's value out of argv, supporting both `--flag value` and `--flag=value`. */
export function flagValue(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag) return args[i + 1]
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1)
  }
  return undefined
}

/**
 * Apply the wake-scoped SEND defaults to a `messages send`/`send-diff` argv (a convenience, never a lock —
 * the model may target any channel explicitly).
 *
 * `--channel` defaults to the channel that woke us. `--reply-to` is the subtle one: it threads the new
 * message under the WAKE EVENT, and that event lives in the woke channel. Defaulting it on a send aimed at a
 * DIFFERENT channel produces a cross-channel parent, which the relay rejects outright —
 * "parent event belongs to a different channel". That broke every cross-channel post (delegating a brief to
 * `research` from a `c-level`/`general` wake) INCLUDING `send_file`, so documents never left: the duck
 * staged correctly, called send_file correctly, and the relay refused the event. So only thread when this
 * send actually targets the woke channel.
 */
export function applySendDefaults(
  args: string[],
  env: { replyChannel?: string; replyTo?: string },
): string[] {
  const positional = args.filter((a) => !a.startsWith('-'))
  const isSend = positional[0] === 'messages' && (positional[1] === 'send' || positional[1] === 'send-diff')
  if (!isSend) return args

  const has = (f: string) => args.some((a) => a === f || a.startsWith(`${f}=`))
  const out = [...args]
  const explicitChannel = has('--channel')
  if (!explicitChannel && env.replyChannel) out.push('--channel', env.replyChannel)

  // Thread only when the target IS the woke channel (either defaulted above, or named explicitly as the
  // same id). Cross-channel ⇒ no parent, or the relay rejects the whole event.
  const target = explicitChannel ? flagValue(args, '--channel') : env.replyChannel
  const targetsWokeChannel = !!env.replyChannel && target === env.replyChannel
  if (!has('--reply-to') && targetsWokeChannel && env.replyTo) out.push('--reply-to', env.replyTo)
  return out
}

export type ChannelLookup = (ref: string) => { ok: true; id: string; name: string | null; trust: string | null; configured: boolean } | { ok: false; error: string }
export type ResolvedChannels = { ok: true; args: string[]; channels: { id: string; name: string | null; trust: string | null; configured: boolean }[] } | { ok: false; error: string }

/**
 * Rewrite every `--channel <ref>` / `--channel=<ref>` through the channel index: a NAME becomes its id, an
 * id passes through (annotated), an unknown name REFUSES the whole command (nothing is sent). Pure over
 * `lookup`, so it is tested without a database. Flags with other names (`--repo-id`, …) are untouched.
 */
export function resolveChannelFlags(args: string[], lookup: ChannelLookup): ResolvedChannels {
  const out: string[] = []
  const channels: ResolvedChannels extends { ok: true; channels: infer C } ? C : never = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const inline = a.startsWith('--channel=')
    if (a !== '--channel' && !inline) { out.push(a); continue }
    const ref = inline ? a.slice('--channel='.length) : args[i + 1]
    if (ref === undefined) { out.push(a); continue }
    const r = lookup(ref)
    if (!r.ok) return { ok: false, error: r.error }
    channels.push({ id: r.id, name: r.name, trust: r.trust, configured: r.configured })
    if (inline) out.push(`--channel=${r.id}`)
    else { out.push('--channel', r.id); i++ }
  }
  return { ok: true, args: out, channels }
}

/** Returns the offending flag + the tool to use instead, or null. Handles `--flag=value` too. */
export function rejectsHostPathFlag(args: string[]): { flag: string; use: string } | null {
  for (const a of args) {
    const bare = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a
    const use = HOST_PATH_FLAGS[bare]
    if (use) return { flag: bare, use }
  }
  return null
}

/** The positional verb path with flag arity accounted for — exported for the read allowlist. */
export function verbPath(args: string[]): string[] {
  return positionalsAritySafe(args)
}

/**
 * READ-ONLY allowlist for the `buzz-read` server (Perceive). An ALLOWLIST, not a deny-list: Perceive is
 * "explore and collect context", and a tool that can also act there would let an injected message turn a
 * read into a post. Anything not listed is refused, including every send/create/set/status/assign verb.
 * Matched on "verb subverb" first, then bare verb (for single-level verbs).
 */
export const READ_ALLOW = new Set([
  'messages get', 'messages thread', 'messages search',
  'channels list', 'channels get', 'channels search', 'channels members',
  'canvas get', 'canvas history',
  'issues list', 'issues get',
  'projects list', 'projects get',
  'repos list', 'repos get',
  'patches list', 'patches get',
  'pr list', 'pr get',
  'users get',
  'feed get',
  'mem ls', 'mem get',
  'reactions get',
])

/** Every verb word in the buzz CLI that MUTATES. Used as a backstop scan over the naive positional path:
 *  the only way a write can hide from the arity-aware parse is behind an unknown value-less flag, and in
 *  that case the naive path still contains the real verb word. (Cost: a read whose free-text argument is
 *  itself a write word, e.g. `messages search --query send`, is refused — acceptable for Perceive.) */
const WRITE_WORDS = new Set([
  'send', 'send-diff', 'edit', 'delete', 'vote', 'set', 'restore', 'create', 'update', 'status', 'assign',
  'unassign', 'open', 'join', 'leave', 'archive', 'unarchive', 'add-member', 'remove-member', 'set-add-policy',
  'topic', 'purpose', 'add-repo', 'remove-repo', 'add-channel', 'bind', 'protect', 'default-branch', 'upload',
  'file', 'rm', 'patch', 'set-profile', 'publish', 'draft-create', 'draft-update', 'ban', 'unban', 'timeout',
  'untimeout', 'resolve', 'add', 'remove',
])

/** Returns the verb path if it is read-only, else null. Fail-closed two ways: the arity-aware path must be
 *  on `READ_ALLOW`, AND the naive path (every non-flag token) must contain no write word — so an unknown
 *  value-less flag can never make the arity parse swallow a write verb unseen. */
export function readOnlyVerb(args: string[]): string | null {
  const verbs = positionalsAritySafe(args)
  const path = `${(verbs[0] || '').toLowerCase()} ${(verbs[1] || '').toLowerCase()}`.trim()
  if (!READ_ALLOW.has(path)) return null
  const naive = args.filter((a) => !a.startsWith('-')).map((a) => a.toLowerCase())
  if (naive.some((tok) => WRITE_WORDS.has(tok))) return null
  return path
}

/**
 * Coerce the model's `args` into a clean argv. The schema asks for an ARRAY of strings, but the live
 * model (mimo-v2.5-pro) regularly ships it as a JSON **string** once `--content` gets long — eleven
 * sends failed overnight 2026-10-12/13 on `data/args must be array`, an operator decision packet among
 * them, and each cost a retry round-trip or the whole act. Two shapes were observed, both repaired here:
 *   1. the array serialised as a string: `'["messages","send","--channel","research","--content","…"]'`;
 *   2. the same with a flag written as an object key: `'[…, "--content": "…"]'` (a colon for a comma).
 * Anything that does not come back as a non-empty array of non-empty strings is refused with the exact
 * shape to send — nothing is guessed, no verb or flag is ever invented. Pure; unit-tested.
 */
export const ARGS_SHAPE = 'args must be a JSON ARRAY of strings, e.g. ["messages","send","--channel","research","--content","text"]'
export type CoercedArgs = { ok: true; args: string[]; repaired: boolean } | { ok: false; error: string }
export function coerceArgs(input: unknown, max = 40): CoercedArgs {
  const accept = (v: unknown, repaired: boolean): CoercedArgs => {
    if (!Array.isArray(v) || v.length === 0 || v.length > max) return { ok: false, error: `${ARGS_SHAPE} (1–${max} items)` }
    if (!v.every((a) => typeof a === 'string' && a.length > 0)) return { ok: false, error: `${ARGS_SHAPE} (every item a non-empty string)` }
    return { ok: true, args: v as string[], repaired }
  }
  if (Array.isArray(input)) return accept(input, false)
  if (typeof input !== 'string') return { ok: false, error: ARGS_SHAPE }
  const s = input.trim()
  if (!s.startsWith('[')) return { ok: false, error: `${ARGS_SHAPE} — got a bare string, not an array` }
  try {
    return accept(JSON.parse(s), true)
  } catch {
    /* fall through to the observed-malformation repairs */
  }
  // `"--flag": "value"` → `"--flag", "value"`; a stray `}` closing the array → `]`.
  const repaired = s.replace(/"(-{1,2}[A-Za-z][\w-]*)"\s*:\s*/g, '"$1", ').replace(/"\s*\}\s*\]\s*$/, '"]')
  try {
    return accept(JSON.parse(repaired), true)
  } catch {
    return { ok: false, error: `${ARGS_SHAPE} — the string sent was not valid JSON` }
  }
}
