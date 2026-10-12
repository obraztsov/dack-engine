/**
 * Pure helpers for the `buzz-git` MCP: repo-dir confinement inside the workspace, remote URL construction
 * (the model never supplies a URL), and the hardened git argv. No I/O here except where noted — tested
 * without a relay. The relay serves real git smart-HTTP at `<relay>/git/<owner-pubkey-hex>/<repo-id>`
 * (Jarvis, 2026-10-12); ACL = membership of the repo's bound channel; auth = NIP-98 (`nip98.ts`).
 */
import { basename, join, isAbsolute, relative, resolve } from 'node:path'
import { realpathSync, statSync } from 'node:fs'

export const REPOS = 'repos'
export const HEX64 = /^[0-9a-f]{64}$/i
/** A repo id (NIP-34 `d` tag) / a clone dir name: one path segment, no dot-leading, bounded. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export type RepoRef = { ok: true; url: string; owner: string; repo: string } | { ok: false; error: string }

/** The only remote a duck may talk to: `<relay>/git/<owner>/<repo>`, built from validated parts. */
export function remoteUrl(relay: string, owner: string, repo: string): RepoRef {
  const base = (relay ?? '').replace(/\/+$/, '')
  if (!/^https?:\/\/[^\s/]+/.test(base)) return { ok: false, error: 'BUZZ_RELAY_URL is not an http(s) URL' }
  if (!HEX64.test(owner)) return { ok: false, error: `owner must be a 64-hex pubkey (got "${owner.slice(0, 20)}…")` }
  if (!SAFE_ID.test(repo)) return { ok: false, error: `repo id "${repo}" is not a valid repo id (letters, digits, . _ -)` }
  if (repo === '.' || repo === '..') return { ok: false, error: 'invalid repo id' }
  return { ok: true, url: `${base}/git/${owner.toLowerCase()}/${repo}`, owner: owner.toLowerCase(), repo }
}

/** A clone dir name: the model's `dir` (or the repo id) as ONE safe segment under `<workspace>/repos`. */
export function cloneDirName(dir: string | undefined, repo: string): { ok: true; name: string } | { ok: false; error: string } {
  const n = (dir ?? repo).trim()
  if (!SAFE_ID.test(n)) return { ok: false, error: `dir "${n}" must be one path segment (letters, digits, . _ -), not a path` }
  return { ok: true, name: n }
}

/**
 * Resolve an EXISTING clone dir inside `<workspace>/repos`: basename only (no traversal), realpath-checked
 * under the repos root, must be a directory with a `.git`. Returns the absolute path.
 */
export function resolveRepoDir(workspaceDir: string | undefined, dir: string): { ok: true; path: string; name: string } | { ok: false; error: string } {
  if (!workspaceDir) return { ok: false, error: 'WORKSPACE_DIR not set — the workspace is unavailable' }
  const name = basename((dir ?? '').trim())
  if (!name || !SAFE_ID.test(name)) return { ok: false, error: `dir "${dir}" is not a clone name (use the name you cloned into, e.g. "looper-onboarding-app")` }
  try {
    const root = realpathSync(join(workspaceDir, REPOS))
    const real = realpathSync(join(workspaceDir, REPOS, name))
    if (!real.startsWith(root + '/')) return { ok: false, error: 'repo dir escapes the workspace' }
    if (!statSync(real).isDirectory()) return { ok: false, error: `${name} is not a directory` }
    if (!statSync(join(real, '.git')).isDirectory()) return { ok: false, error: `${name} is not a git clone (no .git)` }
    return { ok: true, path: real, name }
  } catch {
    return { ok: false, error: `no clone named "${name}" under repos/ — clone it first (repo_clone)` }
  }
}

/** Paths the model names for a commit, confined to the repo (relative inside, no escape); `[]` ⇒ `-A`. */
export function confinePaths(repoDir: string, paths: string[] | undefined): { ok: true; rel: string[] } | { ok: false; error: string } {
  const out: string[] = []
  for (const p of paths ?? []) {
    const abs = isAbsolute(p) ? resolve(p) : resolve(repoDir, p)
    const rel = relative(repoDir, abs)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, error: `path "${p}" is outside the repo` }
    if (rel === '.git' || rel.startsWith('.git/')) return { ok: false, error: 'the .git dir is not yours to stage' }
    out.push(rel)
  }
  return { ok: true, rel: out }
}

/**
 * The hardened `-c` prefix every git invocation carries: no hooks, no filters, https only (no `file://`,
 * `ext::`, ssh), no credential prompts, no submodule fetches, and the duck's identity for commits.
 */
export function gitHardening(identity: { name: string; email: string }): string[] {
  return [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.attributesFile=/dev/null',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    '-c', 'credential.helper=',
    '-c', 'core.askPass=',
    '-c', 'submodule.recurse=false',
    '-c', `user.name=${identity.name}`,
    '-c', `user.email=${identity.email}`,
    '-c', 'commit.gpgsign=false',
  ]
}

/** The duck's git identity: its Buzz key IS its identity (operator decision D). */
export function gitIdentity(selfPubkey: string, relay: string): { name: string; email: string } {
  const host = relay.replace(/^https?:\/\//, '').replace(/[/:].*$/, '') || 'buzz'
  const short = (selfPubkey || 'duck').slice(0, 12)
  return { name: `buzz:${short}`, email: `${short}@${host}` }
}

/** Clip a git stdout/stderr for the model. */
export function clip(s: string, n = 12_000): string {
  return s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more chars clipped]` : s
}
