/**
 * buzz-git — git on Buzz-hosted repositories, INSIDE the duck's workspace (`<workspace>/repos/<dir>`), with
 * the duck's Buzz identity. Replaces "a path on someone else's disk" as the way agents hand each other
 * documents: a result arrives as a COMMIT the duck clones and reads; a deliverable leaves as a commit the
 * duck pushes (design: docs/design/workspace-and-documents.md §3).
 *
 * Security shape:
 *   - remotes are CONSTRUCTED from (owner 64-hex, repo id) → `<relay>/git/<owner>/<repo>`; the model never
 *     supplies a URL; `protocol.allow=never` + `https=always` so `file://`/`ext::`/ssh can't be smuggled
 *   - every clone dir is one safe segment under `repos/`, realpath-checked; commit paths stay inside it
 *   - auth = NIP-98 signed IN-PROCESS (`nip98.ts`) and handed to git as ONE `http.extraHeader`; the key never
 *     reaches argv, disk, or the model. `u` = the repo BASE url (the relay's rule), a fresh nonce per call
 *   - hooks, filters, submodules, credential prompts disabled; `git` runs via execFile (no shell), with a
 *     timeout and bounded output; clone depth + a size ceiling bound disk
 *   - `tier: post`, `trust: org`, `min_trust: org` in the registry — Express only, org cycles only
 *
 * Env (harness-injected): BUZZ_PRIVATE_KEY, BUZZ_RELAY_URL, WORKSPACE_DIR, BUZZ_SELF_PUBKEY, BUZZ_BIN
 * (for `repo_create`, which goes through the buzz CLI's `repos create` + `bind`), BUZZ_GIT_TIMEOUT_SEC (120),
 * BUZZ_GIT_MAX_MB (200), BUZZ_GIT_DEPTH (50, 0 = full). stdout is the MCP channel — log to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execBuzz } from './buzz-exec'
import { openChannelIndex, resolveOne } from './buzz-channels'
import { nip98Event, nip98Header, parseSecretKey, pubkeyOf } from './nip98'
import { remoteUrl, cloneDirName, resolveRepoDir, confinePaths, gitHardening, gitIdentity, clip, REPOS } from './buzz-git'

const RELAY = (process.env.BUZZ_RELAY_URL ?? '').replace(/\/+$/, '')
const WORKSPACE_DIR = process.env.WORKSPACE_DIR
const TIMEOUT_MS = (Number(process.env.BUZZ_GIT_TIMEOUT_SEC) || 120) * 1000
const MAX_MB = Number(process.env.BUZZ_GIT_MAX_MB) || 200
const DEPTH = process.env.BUZZ_GIT_DEPTH === undefined ? 50 : Number(process.env.BUZZ_GIT_DEPTH)
const CHANNELS = openChannelIndex()

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] })
const log = (...a: unknown[]) => console.error('[buzz-git]', ...a)

function key(): Uint8Array | { error: string } {
  const raw = process.env.BUZZ_PRIVATE_KEY
  if (!raw) return { error: 'BUZZ_PRIVATE_KEY not set — identity unavailable' }
  try {
    return parseSecretKey(raw)
  } catch (e) {
    return { error: (e as Error).message }
  }
}
const SELF = (() => {
  const k = key()
  return k instanceof Uint8Array ? pubkeyOf(k) : (process.env.BUZZ_SELF_PUBKEY ?? '')
})()
const IDENTITY = gitIdentity(SELF, RELAY)

type GitResult = { ok: boolean; stdout: string; stderr: string; code: number | null }

/** Run git (execFile, no shell) with the hardening prefix, optionally one NIP-98 header for `remote`. */
function git(args: string[], cwd: string, remote?: string): Promise<GitResult> {
  const k = key()
  const auth: string[] = []
  if (remote && k instanceof Uint8Array) {
    // One signed event for this invocation: `u` = the repo BASE url (what the relay verifies), fresh nonce.
    auth.push('-c', `http.${remote}.extraHeader=Authorization: ${nip98Header(nip98Event(k, remote, 'GET'))}`)
    auth.push('-c', `http.${remote}/.extraHeader=Authorization: ${nip98Header(nip98Event(k, remote, 'POST'))}`)
  }
  const argv = [...gitHardening(IDENTITY), ...auth, ...args]
  return new Promise((resolveP) => {
    execFile(
      'git',
      argv,
      {
        cwd,
        env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', LANG: 'C' },
        timeout: TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === 'number' ? ((err as any).code as number) : err ? null : 0
        resolveP({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code })
      },
    )
  })
}

/** Strip anything that could carry the auth header into the model's view. */
const scrub = (s: string) => s.replace(/Authorization: Nostr [A-Za-z0-9+/=]+/g, 'Authorization: Nostr ***')

function fail(r: GitResult, what: string) {
  const msg = scrub(`${r.stderr}\n${r.stdout}`).trim()
  log(`${what} FAILED code=${r.code}: ${msg.slice(0, 200)}`)
  return asText({ ok: false, error: `${what} failed (exit ${r.code ?? '?'})`, detail: clip(msg, 2000) })
}

function dirSizeMb(p: string): number {
  let total = 0
  const stack = [p]
  while (stack.length) {
    const d = stack.pop()!
    for (const e of require('node:fs').readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile()) total += require('node:fs').statSync(full).size
    }
  }
  return total / (1024 * 1024)
}

const server = new McpServer({ name: 'buzz-git', version: '0.1.0' })

server.registerTool(
  'repo_clone',
  {
    description:
      'Clone a Buzz-hosted git repo into your workspace (`repos/<dir>`). `owner` = the 64-hex pubkey of the agent ' +
      'who announced it (e.g. from `repos list --owner …` or a message), `repo` = its id (the `d` tag). Afterwards ' +
      '`Read` its files under /duck/workspace/repos/<dir>/… (reading caps this cycle at org trust). Shallow by ' +
      `default (depth ${DEPTH || 'full'}); size ceiling ${MAX_MB}MB.`,
    inputSchema: {
      owner: z.string().regex(/^[0-9a-fA-F]{64}$/, '64-hex pubkey'),
      repo: z.string().min(1).max(100),
      dir: z.string().min(1).max(100).optional(),
    },
  },
  async ({ owner, repo, dir }: { owner: string; repo: string; dir?: string }) => {
    if (!WORKSPACE_DIR) return asText({ ok: false, error: 'WORKSPACE_DIR not set' })
    const ref = remoteUrl(RELAY, owner, repo)
    if (!ref.ok) return asText(ref)
    const name = cloneDirName(dir, repo)
    if (!name.ok) return asText(name)
    const target = join(WORKSPACE_DIR, REPOS, name.name)
    if (existsSync(target)) return asText({ ok: false, error: `repos/${name.name} already exists — use repo_pull, or pick another \`dir\`` })
    mkdirSync(join(WORKSPACE_DIR, REPOS), { recursive: true })
    const args = ['clone', '--no-recurse-submodules', ...(DEPTH > 0 ? ['--depth', String(DEPTH)] : []), ref.url, target]
    const r = await git(args, join(WORKSPACE_DIR, REPOS), ref.url)
    if (!r.ok) {
      rmSync(target, { recursive: true, force: true })
      return fail(r, `clone ${repo}`)
    }
    const mb = dirSizeMb(target)
    if (mb > MAX_MB) {
      rmSync(target, { recursive: true, force: true })
      return asText({ ok: false, error: `clone is ${mb.toFixed(0)}MB > ${MAX_MB}MB ceiling — removed` })
    }
    const head = await git(['log', '-1', '--format=%h %s'], target)
    log(`cloned ${ref.owner.slice(0, 8)}…/${repo} → repos/${name.name} (${mb.toFixed(1)}MB)`)
    return asText({ ok: true, dir: name.name, path: `${REPOS}/${name.name}`, remote: ref.url, head: head.stdout.trim(), size_mb: Number(mb.toFixed(1)), hint: `Read files under ${target}/ …` })
  },
)

server.registerTool(
  'repo_pull',
  { description: 'Fetch + fast-forward a clone in `repos/<dir>` from its origin.', inputSchema: { dir: z.string().min(1).max(120) } },
  async ({ dir }: { dir: string }) => {
    const d = resolveRepoDir(WORKSPACE_DIR, dir)
    if (!d.ok) return asText(d)
    const origin = (await git(['remote', 'get-url', 'origin'], d.path)).stdout.trim()
    const r = await git(['pull', '--ff-only', '--no-recurse-submodules'], d.path, origin)
    if (!r.ok) return fail(r, `pull ${d.name}`)
    return asText({ ok: true, dir: d.name, result: clip(scrub(r.stdout + r.stderr).trim(), 2000) })
  },
)

server.registerTool(
  'repo_status',
  { description: 'Working-tree status of a clone in `repos/<dir>` (short form) + current branch and HEAD.', inputSchema: { dir: z.string().min(1).max(120) } },
  async ({ dir }: { dir: string }) => {
    const d = resolveRepoDir(WORKSPACE_DIR, dir)
    if (!d.ok) return asText(d)
    const st = await git(['status', '--short', '--branch'], d.path)
    const head = await git(['log', '-1', '--format=%h %s (%an, %cr)'], d.path)
    return asText({ ok: st.ok, dir: d.name, status: clip(st.stdout, 6000), head: head.stdout.trim() })
  },
)

server.registerTool(
  'repo_diff',
  { description: 'Diff of uncommitted changes in `repos/<dir>` (optionally one path), unified format.', inputSchema: { dir: z.string().min(1).max(120), path: z.string().max(512).optional() } },
  async ({ dir, path }: { dir: string; path?: string }) => {
    const d = resolveRepoDir(WORKSPACE_DIR, dir)
    if (!d.ok) return asText(d)
    const paths = confinePaths(d.path, path ? [path] : [])
    if (!paths.ok) return asText(paths)
    const r = await git(['diff', 'HEAD', '--', ...paths.rel], d.path)
    if (!r.ok) return fail(r, `diff ${d.name}`)
    return asText({ ok: true, dir: d.name, diff: clip(r.stdout, 20_000) || '(no changes)' })
  },
)

server.registerTool(
  'repo_log',
  { description: 'Recent commits of a clone in `repos/<dir>`.', inputSchema: { dir: z.string().min(1).max(120), n: z.number().int().min(1).max(100).optional() } },
  async ({ dir, n }: { dir: string; n?: number }) => {
    const d = resolveRepoDir(WORKSPACE_DIR, dir)
    if (!d.ok) return asText(d)
    const r = await git(['log', `-${n ?? 20}`, '--format=%h %ad %an: %s', '--date=short'], d.path)
    if (!r.ok) return fail(r, `log ${d.name}`)
    return asText({ ok: true, dir: d.name, log: clip(r.stdout, 8000) })
  },
)

server.registerTool(
  'repo_commit',
  {
    description:
      'Stage + commit your changes in `repos/<dir>` as your Buzz identity. `paths` (repo-relative) limits what is staged; ' +
      'omit to stage everything changed. Edit files first with Write/Edit under /duck/workspace/repos/<dir>/…',
    inputSchema: { dir: z.string().min(1).max(120), message: z.string().min(1).max(4000), paths: z.array(z.string().min(1).max(512)).max(100).optional() },
  },
  async ({ dir, message, paths }: { dir: string; message: string; paths?: string[] }) => {
    const d = resolveRepoDir(WORKSPACE_DIR, dir)
    if (!d.ok) return asText(d)
    const p = confinePaths(d.path, paths)
    if (!p.ok) return asText(p)
    const add = await git(p.rel.length ? ['add', '--', ...p.rel] : ['add', '-A'], d.path)
    if (!add.ok) return fail(add, `stage ${d.name}`)
    const trailer = `Buzz-Pubkey: ${SELF}`
    const c = await git(['commit', '-q', '-m', message, '-m', trailer], d.path)
    if (!c.ok) return fail(c, `commit ${d.name}`)
    const head = await git(['log', '-1', '--format=%H %s'], d.path)
    log(`committed in ${d.name}: ${head.stdout.trim().slice(0, 60)}`)
    return asText({ ok: true, dir: d.name, commit: head.stdout.trim(), hint: 'repo_push to publish it; post the commit id in the channel' })
  },
)

server.registerTool(
  'repo_push',
  { description: 'Push the current branch of `repos/<dir>` to its origin (the Buzz relay; the repo\'s channel membership decides).', inputSchema: { dir: z.string().min(1).max(120) } },
  async ({ dir }: { dir: string }) => {
    const d = resolveRepoDir(WORKSPACE_DIR, dir)
    if (!d.ok) return asText(d)
    const origin = (await git(['remote', 'get-url', 'origin'], d.path)).stdout.trim()
    if (!origin.startsWith(`${RELAY}/git/`)) return asText({ ok: false, error: 'origin is not on this relay — refusing to push elsewhere' })
    const r = await git(['push', '-u', 'origin', 'HEAD'], d.path, origin)
    if (!r.ok) return fail(r, `push ${d.name}`)
    const head = await git(['log', '-1', '--format=%H'], d.path)
    log(`pushed ${d.name} @ ${head.stdout.trim().slice(0, 8)}`)
    return asText({ ok: true, dir: d.name, pushed: head.stdout.trim(), remote: origin, result: clip(scrub(r.stderr).trim(), 1500) })
  },
)

server.registerTool(
  'repo_create',
  {
    description:
      'Announce a NEW repo on the relay (NIP-34) bound to a channel (its members get clone/push), then clone it into ' +
      '`repos/<id>`. `channel` is a channel NAME or id. NOTE: a repo id must NOT equal a channel name — the relay then ' +
      'never provisions it (looper-onboarding failed this way; looper-onboarding-app works).',
    inputSchema: { id: z.string().min(1).max(100), channel: z.string().min(1).max(200), name: z.string().max(120).optional(), description: z.string().max(500).optional() },
  },
  async ({ id, channel, name, description }: { id: string; channel: string; name?: string; description?: string }) => {
    if (!WORKSPACE_DIR) return asText({ ok: false, error: 'WORKSPACE_DIR not set' })
    const ref = remoteUrl(RELAY, SELF, id)
    if (!ref.ok) return asText(ref)
    const ch = resolveOne(CHANNELS, channel)
    if (!ch.ok) return asText(ch)
    if (CHANNELS && CHANNELS.names.some((n) => n.toLowerCase() === id.toLowerCase()))
      return asText({ ok: false, error: `"${id}" is also a channel name — the relay will not provision a repo with that id; pick e.g. "${id}-repo"` })
    const create = await execBuzz(['repos', 'create', '--id', id, '--name', name ?? id, '--description', description ?? '', '--clone', ref.url, '--web', ref.url, '--channel', ch.id], 'buzz-git')
    if (!create.ok) return asText({ ok: false, error: `repos create failed: ${create.error ?? ''}`.slice(0, 500) })
    const target = join(WORKSPACE_DIR, REPOS, id)
    if (existsSync(target)) return asText({ ok: true, announced: ref.url, note: `repos/${id} already present locally` })
    mkdirSync(join(WORKSPACE_DIR, REPOS), { recursive: true })
    // The relay provisions the bare repo asynchronously; a first clone may race it — retry briefly.
    let last: GitResult | null = null
    for (let i = 0; i < 4; i++) {
      last = await git(['clone', ref.url, target], join(WORKSPACE_DIR, REPOS), ref.url)
      if (last.ok) break
      rmSync(target, { recursive: true, force: true })
      await new Promise((r) => setTimeout(r, 3000))
    }
    if (!last?.ok) return asText({ ok: true, announced: ref.url, cloned: false, warning: 'announced, but the relay has not provisioned the repo yet — repo_clone it in a minute' })
    log(`created + cloned ${id} bound to ${ch.name ?? ch.id}`)
    return asText({ ok: true, announced: ref.url, dir: id, path: `${REPOS}/${id}`, channel: ch.name ?? ch.id })
  },
)

await server.connect(new StdioServerTransport())
log(`ready — relay=${RELAY || '(unset)'} workspace=${WORKSPACE_DIR ?? '(unset)'} self=${SELF.slice(0, 8) || '?'} identity=${IDENTITY.name}`)
