/**
 * sandbox — run a command under **bubblewrap** with a default-empty filesystem (Linux only).
 *
 * This is the FS-confinement primitive that makes `bash`-in-Settle safe (see
 * docs/design/… / the agentic-skills epoch). bubblewrap starts the child in an EMPTY mount namespace and
 * you bind in *only* what you name — so the duck's crown jewels (`identities/` = the soul signing key,
 * `secrets/`, `dack.config.yaml`, the soul `.git`) are invisible **by default**, because we never bind
 * them. The child sees: a read-only system runtime, a read-only skill dir, and one writable workspace.
 *
 * The environment is cleared and re-populated with only a minimal PATH/HOME plus the caller-supplied
 * scoped secrets — the model's key never leaks in from the host env. Namespaces (user/pid/ipc/uts/cgroup)
 * are unshared; the network namespace is *shared* for now (egress allow-listing is a follow-up — v1 leans
 * on the scoped key + the upstream service's own limits). `--die-with-parent` + a hard timeout bound it.
 *
 * Linux-only by design: bubblewrap does not exist on macOS. Dev/test happens in a Linux container
 * (`docker run … bubblewrap`), which is also how the duck runs in production.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface SandboxOpts {
  /** The shell command to run (via `bash -lc`). */
  command: string
  /** Host path mounted READ-WRITE as the working dir + $HOME. The ONLY writable location. */
  workspace: string
  /** Optional host path mounted READ-ONLY (a skill's dir: SKILL.md + references/ + bin/). */
  skillDir?: string
  /** Scoped env for the child (e.g. { BANKR_API_KEY }). The env is otherwise CLEARED. */
  env?: Record<string, string>
  /** Extra read-only binds (host absolute paths). Defaults cover the Linux system runtime. */
  roBinds?: string[]
  /** Hard timeout; the child is killed after this. */
  timeoutSec?: number
  /** Path to the bwrap binary (default `bwrap`). */
  bwrapBin?: string
}

/** The standard Linux system paths a shell + common CLIs (node/bun/curl/git) need, read-only. Only the
 *  ones that exist on this host are returned, so the arg list stays valid across base images. */
export function defaultRoBinds(exists: (p: string) => boolean = existsSync): string[] {
  const candidates = [
    '/usr', '/bin', '/sbin', '/lib', '/lib64', // runtime + global CLIs (usrmerge-safe: symlinks resolve)
    '/etc/ssl', '/etc/ca-certificates.crt', '/etc/ca-certificates', // TLS trust
    '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', // DNS / name resolution
    '/etc/passwd', '/etc/group', // uid/gid lookup (read-only; no secrets here)
    '/etc/alternatives', // update-alternatives symlinks (e.g. `sh`)
  ]
  return candidates.filter(exists)
}

/**
 * Build the bwrap argv (pure — no I/O beyond the injected `exists`, so it unit-tests on any OS).
 * The result is `[bwrapBin, ...flags, 'bash', '-lc', command]`.
 */
export function buildBwrapArgs(opts: SandboxOpts, exists: (p: string) => boolean = existsSync): string[] {
  const bwrap = opts.bwrapBin ?? 'bwrap'
  const ro = opts.roBinds ?? defaultRoBinds(exists)
  const args: string[] = [
    bwrap,
    // Isolate every namespace but the network (egress filtering is a follow-up).
    '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
    '--die-with-parent', // child dies if the runner dies — no escapees
    '--new-session', // detach controlling tty (no TIOCSTI injection)
    '--clearenv', // start from an EMPTY env; we re-add only what's below
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
  ]
  // Read-only system runtime — only existing paths (kept in sync by defaultRoBinds).
  for (const p of ro) args.push('--ro-bind', p, p)
  // The one writable location: the workspace, doubling as $HOME + cwd.
  args.push('--bind', opts.workspace, opts.workspace)
  // The skill's own dir, read-only, if given.
  if (opts.skillDir) args.push('--ro-bind-try', opts.skillDir, opts.skillDir)
  // Minimal, explicit env. HOME/cwd = the workspace so tool state (e.g. a CLI's config) lands there.
  const env: Record<string, string> = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: opts.workspace,
    LANG: 'C.UTF-8',
    ...(opts.env ?? {}),
  }
  for (const [k, v] of Object.entries(env)) args.push('--setenv', k, v)
  args.push('--chdir', opts.workspace)
  // The payload. `-l` gives a login shell so a skill's `bankr`/`node` on PATH resolves normally.
  args.push('bash', '-lc', opts.command)
  return args
}

/**
 * Preflight: can bubblewrap actually confine in THIS environment? Runs a minimal real invocation
 * (unshare + proc/dev mount + a bind) and checks it exits clean. The bash capability MUST call this and
 * **refuse to run if it fails** — a sandbox that can't create its namespaces must fail CLOSED, never
 * degrade to unconfined bash. (Common failure: a container without unprivileged user-namespaces / a
 * seccomp profile that blocks `CLONE_NEWUSER` → run the duck container with a profile that permits it.)
 */
export async function preflightSandbox(bwrapBin = 'bwrap'): Promise<{ ok: boolean; error?: string }> {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  let ws: string
  try {
    ws = mkdtempSync(join(tmpdir(), 'sbx-preflight-'))
  } catch (e) {
    return { ok: false, error: `workspace mkdtemp failed: ${e}` }
  }
  try {
    const r = await runSandboxed({ command: 'true', workspace: ws, timeoutSec: 10, bwrapBin })
    if (r.code === 0 && !r.timedOut) return { ok: true }
    return { ok: false, error: (r.stderr || `exit ${r.code}${r.timedOut ? ' (timeout)' : ''}`).trim().slice(0, 300) }
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 300) }
  }
}

export interface SandboxResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** Run `command` confined. Rejects only on spawn failure; a nonzero exit is a normal result. */
export function runSandboxed(opts: SandboxOpts): Promise<SandboxResult> {
  const argv = buildBwrapArgs(opts)
  const [bin, ...rest] = argv
  const timeoutMs = (opts.timeoutSec ?? 120) * 1000
  return new Promise((resolve, reject) => {
    // Spawn bwrap with a minimal env of its own (it re-clears for the child via --clearenv anyway).
    const child = spawn(bin, rest, { env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const cap = (s: string, add: string) => (s.length > 200_000 ? s : s + add).slice(0, 200_000)
    child.stdout.on('data', (d) => (stdout = cap(stdout, d.toString())))
    child.stderr.on('data', (d) => (stderr = cap(stderr, d.toString())))
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

// ── CLI (for in-container confinement testing): SANDBOX_WORKSPACE=… bun run sandbox.ts '<command>' ──
if (import.meta.main) {
  const command = process.argv[2] ?? 'echo hello from the sandbox'
  const workspace = process.env.SANDBOX_WORKSPACE
  if (!workspace) {
    console.error('set SANDBOX_WORKSPACE=<a writable dir>')
    process.exit(2)
  }
  const scoped: Record<string, string> = {}
  if (process.env.SANDBOX_TEST_SECRET) scoped.SANDBOX_TEST_SECRET = process.env.SANDBOX_TEST_SECRET
  const r = await runSandboxed({ command, workspace, skillDir: process.env.SANDBOX_SKILL_DIR, env: scoped, timeoutSec: 30 })
  process.stdout.write(r.stdout)
  process.stderr.write(r.stderr)
  if (r.timedOut) console.error('[sandbox] TIMED OUT')
  process.exit(r.code ?? 1)
}
