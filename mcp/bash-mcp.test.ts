import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// On the mac dev box bubblewrap is absent, so the sandbox preflight fails → the bash tool MUST refuse
// (fail-closed), never run unconfined. (On a Linux+bwrap/Kata host this path instead executes confined;
// that is exercised on the VPS.) This guards the invariant that a broken sandbox never degrades to raw bash.
describe('bash-mcp', () => {
  it('fails CLOSED when the sandbox cannot confine here', async () => {
    process.env.BASH_WORKSPACE = mkdtempSync(join(tmpdir(), 'bashmcp-'))
    process.env.BASH_SECRET_ENV = ''
    const { runBash } = await import('./bash-mcp')
    const r = await runBash('echo should-not-run-unconfined')
    expect(r.ok).toBe(false)
    // Either refused at preflight (no bwrap — the dev box) or the sandbox errored; NEVER a clean unconfined run.
    expect(r.refused === true || typeof r.error === 'string').toBe(true)
    if (r.refused) expect(String(r.reason)).toContain('fail-closed')
    // The command's stdout must never appear un-sandboxed.
    expect(JSON.stringify(r)).not.toContain('should-not-run-unconfined\n')
  })
})
