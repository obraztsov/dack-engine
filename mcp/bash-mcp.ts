/**
 * bash — a Settle-tier MCP that runs a shell command inside the bubblewrap sandbox (mcp/sandbox.ts).
 *
 * This is how a duck runs a plain-text (Claude/Hermes `SKILL.md`) skill that needs arbitrary CLIs / curl
 * (e.g. the Bankr `bankr` CLI, x402 `curl`). It is deliberately an MCP server, NOT a native Bash tool:
 *   - Register it as an `mcp_server` with `tier: settle` and the wall classes every call **SettleTx** →
 *     admitted ONLY in the Settle state, on a cycle whose trust ceiling reaches settle. Bash is
 *     irreversible; Settle is dack's irreversible-authority state. Not registering it = the capability is
 *     OFF (the default).
 *   - Every command runs CONFINED (bubblewrap): an empty-FS mount namespace binds in only a scratch
 *     workspace, the skill dirs (read-only), and the system runtime — so the duck's `identities/` (soul
 *     signing key), `secrets/`, and config are invisible. The env is cleared and re-populated with only the
 *     operator-scoped skill secret(s).
 *   - **Fail-closed:** if the sandbox can't confine in this environment (e.g. a non-Kata runc container
 *     without user namespaces — see docs/…/agentic-skills-design.md §6), every call REFUSES. It never
 *     degrades to unconfined bash.
 *
 * Env (operator config, injected by the harness/pond — never the model):
 *   BASH_WORKSPACE      writable scratch dir (the only writable mount; also $HOME). Required.
 *   BASH_SKILL_DIRS     `:`-separated skill dirs mounted read-only (SKILL.md + references + bin). Optional.
 *   BASH_SECRET_ENV     `,`-separated env var NAMES to forward from THIS process's env into the sandbox
 *                       (e.g. `BANKR_API_KEY`). The values come from the secret broker; the model never
 *                       sees them. Only listed names are forwarded.
 *   BASH_ALLOWED_BINS   `,`-separated advisory allowlist of CLIs (shown to the model; PATH-level
 *                       enforcement is a follow-up).
 *   BASH_MAX_TIMEOUT_SEC  hard cap per command (default 120).
 *
 * stdout is the MCP protocol channel — never log to it; use stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { mkdirSync } from 'node:fs'
import { z } from 'zod'
import { preflightSandbox, runSandboxed } from './sandbox'

const WORKSPACE = process.env.BASH_WORKSPACE ?? ''
const SKILL_DIRS = (process.env.BASH_SKILL_DIRS ?? '').split(':').filter(Boolean)
const SECRET_ENV = (process.env.BASH_SECRET_ENV ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const ALLOWED_BINS = (process.env.BASH_ALLOWED_BINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const MAX_TIMEOUT = Number(process.env.BASH_MAX_TIMEOUT_SEC ?? 120)

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v) }] })
const log = (...a: unknown[]) => console.error('[bash-mcp]', ...a)

// Preflight ONCE, lazily, and cache — the bash tool refuses if the sandbox can't confine here (fail-closed).
let sandboxOk: { ok: boolean; error?: string } | null = null
async function ensureSandbox(): Promise<{ ok: boolean; error?: string }> {
  if (sandboxOk === null) {
    if (!WORKSPACE) sandboxOk = { ok: false, error: 'BASH_WORKSPACE is not set' }
    else {
      try {
        mkdirSync(WORKSPACE, { recursive: true })
      } catch (e) {
        return { ok: false, error: `workspace unavailable: ${e}` }
      }
      sandboxOk = await preflightSandbox()
    }
    log(sandboxOk.ok ? 'sandbox preflight OK — bash confined' : `sandbox preflight FAILED (refusing all bash): ${sandboxOk.error}`)
  }
  return sandboxOk
}

/** The tool's core — testable without the stdio transport. Fail-closed if the sandbox can't confine. */
export async function runBash(command: string, timeout_sec?: number): Promise<Record<string, unknown>> {
  const pf = await ensureSandbox()
  if (!pf.ok) return { ok: false, refused: true, reason: `sandbox unavailable — refusing (fail-closed): ${pf.error}` }
  const env: Record<string, string> = {}
  for (const name of SECRET_ENV) if (process.env[name]) env[name] = process.env[name]!
  try {
    const r = await runSandboxed({
      command,
      workspace: WORKSPACE,
      skillDir: SKILL_DIRS[0], // v1: one skill dir; multi-dir mount is a follow-up
      env,
      timeoutSec: Math.min(timeout_sec ?? MAX_TIMEOUT, MAX_TIMEOUT),
    })
    log(`ran (${command.slice(0, 60).replace(/\n/g, ' ')}…) → exit ${r.code}${r.timedOut ? ' TIMEOUT' : ''}`)
    return { ok: !r.timedOut && r.code === 0, exit_code: r.code, timed_out: r.timedOut, stdout: r.stdout, stderr: r.stderr }
  } catch (e) {
    log('sandbox run error:', e)
    return { ok: false, error: `sandbox execution failed: ${e}` }
  }
}

export function makeServer(): McpServer {
  const server = new McpServer({ name: 'bash', version: '0.1.0' })
  server.registerTool(
    'bash',
    {
      description:
        'Run a shell command inside a CONFINED sandbox (Settle-tier only). Use it to execute a plain-text ' +
        "skill's CLI / curl calls (e.g. `bankr …`). The sandbox has a writable workspace (your $HOME) and " +
        'read-only skill dirs; it CANNOT see the agent identity, secrets, or config. Scoped skill credentials ' +
        'are already in the env — never paste a key. One command per call; keep it short.' +
        (ALLOWED_BINS.length ? ` Available CLIs: ${ALLOWED_BINS.join(', ')}.` : ''),
      inputSchema: {
        command: z.string().min(1).max(8000),
        timeout_sec: z.number().int().positive().max(MAX_TIMEOUT).optional(),
      },
    },
    async ({ command, timeout_sec }: { command: string; timeout_sec?: number }) => asText(await runBash(command, timeout_sec)),
  )
  return server
}

if (import.meta.main) {
  await makeServer().connect(new StdioServerTransport())
  log(`ready — workspace=${WORKSPACE || 'UNSET'} skill_dirs=${SKILL_DIRS.length} secrets=[${SECRET_ENV.join(',')}] max_timeout=${MAX_TIMEOUT}s`)
}
