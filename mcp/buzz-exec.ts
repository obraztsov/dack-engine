/**
 * The ONE hardened way to spawn the `buzz` binary — shared by the write-enabled `buzz-cli` MCP and the
 * read-only `buzz-read` MCP, so identity injection, flag stripping, output caps and timeouts are written
 * once and cannot drift between the two servers.
 *
 *   - identity + relay come from the env the harness materialized (BUZZ_PRIVATE_KEY via the secrets broker,
 *     BUZZ_RELAY_URL); any `--relay` / `--private-key` / `--key` the model passes is STRIPPED — it can never
 *     redirect a call to another relay or another identity;
 *   - execFile, never a shell: argv is an array, there is no injection surface;
 *   - `--format json` is prepended (a GLOBAL flag — it must precede the subcommand);
 *   - stdout is capped so a huge query cannot blow the context; the child's env is narrowed to PATH + the
 *     two buzz vars.
 *
 * Policy (what may run) lives in the servers and in `buzz-args.ts`; this module only knows HOW to run.
 */
import { execFile } from 'node:child_process'

export type BuzzResult = { ok: boolean; out?: string; error?: string; code?: number }

export const BUZZ_BIN = process.env.BUZZ_BIN || 'dack-soul/skills/buzz/bin/buzz'
export const BUZZ_RELAY = process.env.BUZZ_RELAY_URL || ''
const TIMEOUT_MS = (Number(process.env.BUZZ_CLI_TIMEOUT_SEC) || 45) * 1000
const MAX_OUT = 64 * 1024

/** Drop any flag that would override the injected identity/relay. */
export function stripIdentityFlags(rawArgs: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]
    if (a === '--relay' || a === '--private-key' || a === '--key') { i++; continue }
    if (a.startsWith('--relay=') || a.startsWith('--private-key=') || a.startsWith('--key=')) continue
    out.push(a)
  }
  return out
}

/** Run the binary with already-policy-checked argv. `tag` labels the stderr log line. */
export function execBuzz(args: string[], tag = 'buzz', opts: { maxOut?: number } = {}): Promise<BuzzResult> {
  // `maxOut` is for a caller that DIGESTS the output locally and never hands it to the model (own_replies
  // reads a whole thread to pick out a few posts): the default cap protects the context, not the host.
  const maxOut = opts.maxOut ?? MAX_OUT
  if (!args.some((a) => a === '--format')) args = ['--format', 'json', ...args]
  const key = process.env.BUZZ_PRIVATE_KEY
  if (!key) return Promise.resolve({ ok: false, error: 'BUZZ_PRIVATE_KEY not set — identity unavailable' })
  if (!BUZZ_RELAY) return Promise.resolve({ ok: false, error: 'BUZZ_RELAY_URL not set' })
  const verb = args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')
  return new Promise((resolve) => {
    execFile(
      BUZZ_BIN,
      args,
      { env: { PATH: process.env.PATH, BUZZ_PRIVATE_KEY: key, BUZZ_RELAY_URL: BUZZ_RELAY }, timeout: TIMEOUT_MS, maxBuffer: maxOut, windowsHide: true },
      (err, stdout, stderr) => {
        const out = (stdout || '').slice(0, maxOut)
        if (err) {
          const msg = (stderr || (err as Error).message || 'buzz failed').slice(0, 2000)
          console.error(`[${tag}] FAILED verb=${verb} code=${(err as any).code}`)
          resolve({ ok: false, error: msg, code: (err as any).code })
        } else {
          console.error(`[${tag}] ok verb=${verb}`)
          resolve({ ok: true, out: out || (stderr || '').slice(0, maxOut) })
        }
      },
    )
  })
}
