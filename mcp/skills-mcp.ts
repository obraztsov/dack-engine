/**
 * skills — read-only navigation for plain-text (Claude/Hermes `SKILL.md`) skills.
 *
 * Progressive disclosure has three tiers: (1) a name+description LIST — the duck already gets this as a
 * wake catalogue; this MCP re-exposes it on demand as `list_skills`. (2) a skill's SKILL.md BODY and (3)
 * its `references/`/`scripts/`/… — both are just files the model reads. `view_skill` is the one genuine
 * convenience over a raw `Read`: it resolves a bare skill NAME to its absolute dir, returns the body, and
 * enumerates the support files so the model has an explicit menu instead of guessing paths / globbing.
 * (Modeled on Hermes' `skill_view`; dack keeps it read-only and does NOT honor `SKILL.md` inline `` !`…` ``
 * execution or `allowed-tools` self-grant — skills are prose the model reads, executed only via the
 * separate Settle `bash` tool.)
 *
 * Read-only + confined to the skills root, so it's a `tier: read` capability, safe in every state.
 * stdout is the MCP channel — log only to stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

const SKILLS_ROOT = resolve(process.env.SKILLS_ROOT ?? 'skills')
const SUPPORT_DIRS = ['references', 'templates', 'assets', 'scripts'] as const
const BODY_CAP = 20_000 // large SKILL.md (e.g. bankr ~105 KB) → return a head; the model Reads the rest.
const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] })
const log = (...a: unknown[]) => console.error('[skills-mcp]', ...a)

/** Split `---\n<yaml>\n---\n<body>` → {fm, body}. */
export function splitFrontmatter(md: string): { fm: Record<string, unknown>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { fm: {}, body: md }
  let fm: Record<string, unknown> = {}
  try {
    fm = (parseYaml(m[1]) as Record<string, unknown>) ?? {}
  } catch (e) {
    log('frontmatter parse failed:', e)
  }
  return { fm, body: m[2] ?? '' }
}

/** `requires.bins` at `metadata.requires.bins` or one namespace down (`metadata.<ns>.requires.bins`). */
export function requiredBins(metadata: unknown): string[] {
  const binsOf = (v: unknown): string[] => {
    const bins = (v as any)?.requires?.bins
    return Array.isArray(bins) ? bins.filter((b) => typeof b === 'string') : []
  }
  const top = binsOf(metadata)
  if (top.length) return top
  if (metadata && typeof metadata === 'object') {
    for (const v of Object.values(metadata as Record<string, unknown>)) {
      const nested = binsOf(v)
      if (nested.length) return nested
    }
  }
  return []
}

/** A model-supplied skill name → its confined absolute dir, or null (traversal / not a dir / escapes root). */
export function skillDir(name: string): string | null {
  if (!name || name !== basename(name) || name.includes('..')) return null
  const dir = join(SKILLS_ROOT, name)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null
  try {
    if (!realpathSync(dir).startsWith(realpathSync(SKILLS_ROOT))) return null
  } catch {
    return null
  }
  return dir
}

function skillMeta(dir: string): { name: string; description: string; needs_bins: string[] } | null {
  const md = join(dir, 'SKILL.md')
  if (!existsSync(md)) return null
  const { fm } = splitFrontmatter(readFileSync(md, 'utf8'))
  const name = String(fm.name ?? basename(dir)).trim() || basename(dir)
  const description = String(fm.description ?? '').replace(/\s+/g, ' ').trim()
  return { name, description, needs_bins: requiredBins(fm.metadata) }
}

const server = new McpServer({ name: 'skills', version: '0.1.0' })

server.registerTool(
  'list_skills',
  { description: 'List the plain-text skills available (name, description, and any required CLIs). Use view_skill(name) to read one.', inputSchema: {} },
  async () => {
    if (!existsSync(SKILLS_ROOT)) return asText({ skills: [] })
    const skills = readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => skillMeta(join(SKILLS_ROOT, e.name)))
      .filter((m): m is NonNullable<typeof m> => !!m && m.description !== '')
      .sort((a, b) => a.name.localeCompare(b.name))
    return asText({ skills })
  },
)

server.registerTool(
  'view_skill',
  {
    description:
      "Load a plain-text skill: returns its SKILL.md body plus a menu of its reference/script/asset/template " +
      'files (read those on demand with the Read tool at the returned skill_dir). This is how you learn a ' +
      "skill's instructions before running its CLI via the bash tool.",
    inputSchema: { name: z.string().min(1).max(64) },
  },
  async ({ name }: { name: string }) => {
    const dir = skillDir(name)
    if (!dir) return asText({ ok: false, error: `no such skill '${name}'` })
    const md = join(dir, 'SKILL.md')
    if (!existsSync(md)) return asText({ ok: false, error: `skill '${name}' has no SKILL.md` })
    const { fm, body } = splitFrontmatter(readFileSync(md, 'utf8'))
    const linked_files: Record<string, string[]> = {}
    for (const sub of SUPPORT_DIRS) {
      const d = join(dir, sub)
      if (existsSync(d) && statSync(d).isDirectory()) {
        const files = readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => `${sub}/${e.name}`).sort()
        if (files.length) linked_files[sub] = files
      }
    }
    return asText({
      ok: true,
      name: String(fm.name ?? name),
      skill_dir: dir,
      description: String(fm.description ?? '').replace(/\s+/g, ' ').trim(),
      needs_bins: requiredBins(fm.metadata),
      body: body.length > BODY_CAP ? body.slice(0, BODY_CAP) : body,
      truncated: body.length > BODY_CAP ? `body capped at ${BODY_CAP} chars — Read ${basename(dir)}/SKILL.md for the rest` : undefined,
      linked_files,
    })
  },
)

if (import.meta.main) {
  await server.connect(new StdioServerTransport())
  log(`ready — skills_root=${SKILLS_ROOT}`)
}
