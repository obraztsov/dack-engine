/**
 * Pure argv policy for the generic `buzz` CLI wrapper MCP — the two fail-closed gates applied before we
 * ever spawn the binary. Kept in its own module (no I/O) so both are unit-testable: they are the whole
 * security boundary of a tool that otherwise hands the model a real CLI.
 */

/** Irreversible / admin verbs a chatting agent should not casually run. Matched against the first
 *  positional and the first-two ("verb subverb"). Operator override: BUZZ_CLI_DENY="" allows everything. */
export const DEFAULT_DENY = [
  'agents', 'workflows', 'repos', 'projects', // identity / automation / git admin
  'messages delete', 'messages edit',
  'channels create', 'channels update', 'channels delete', 'channels leave',
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
  '--output': 'media_fetch',
  '-o': 'media_fetch',
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

/** Returns the offending flag + the tool to use instead, or null. Handles `--flag=value` too. */
export function rejectsHostPathFlag(args: string[]): { flag: string; use: string } | null {
  for (const a of args) {
    const bare = a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a
    const use = HOST_PATH_FLAGS[bare]
    if (use) return { flag: bare, use }
  }
  return null
}
