import { describe, expect, it } from 'bun:test'
import { buildBwrapArgs, defaultRoBinds } from './sandbox'

// A fake `exists` so the pure builder tests run identically on any OS (incl. the macOS dev box).
const existsAll = () => true

describe('buildBwrapArgs', () => {
  const base = { command: 'echo hi', workspace: '/duck/sandbox/bankr', env: { BANKR_API_KEY: 'bk_secret' } }

  it('clears the env and re-adds only the scoped secret + minimal PATH/HOME', () => {
    const a = buildBwrapArgs(base, existsAll).join(' ')
    expect(a).toContain('--clearenv')
    expect(a).toContain('--setenv BANKR_API_KEY bk_secret')
    expect(a).toContain('--setenv HOME /duck/sandbox/bankr')
    expect(a).toContain('--setenv PATH ')
  })

  it('binds the workspace read-WRITE and the system runtime read-only', () => {
    const args = buildBwrapArgs(base, existsAll)
    const s = args.join(' ')
    expect(s).toContain('--bind /duck/sandbox/bankr /duck/sandbox/bankr') // rw workspace
    expect(s).toContain('--ro-bind /usr /usr') // ro system
    // `--bind` (rw) appears exactly once — only the workspace is writable.
    expect(args.filter((x) => x === '--bind').length).toBe(1)
  })

  it('NEVER binds the crown jewels (they are invisible by default — empty FS)', () => {
    const s = buildBwrapArgs(base, existsAll).join(' ')
    for (const jewel of ['identities', 'secrets', 'dack.config.yaml', '.git']) {
      expect(s).not.toContain(jewel)
    }
  })

  it('runs the payload via a login shell and isolates namespaces (net shared)', () => {
    const args = buildBwrapArgs(base, existsAll)
    expect(args.slice(-3)).toEqual(['bash', '-lc', 'echo hi'])
    const s = args.join(' ')
    expect(s).toContain('--unshare-user')
    expect(s).toContain('--unshare-pid')
    expect(s).toContain('--die-with-parent')
    expect(s).not.toContain('--unshare-net') // network deliberately shared in v1
  })

  it('mounts a skill dir read-only when given', () => {
    const s = buildBwrapArgs({ ...base, skillDir: '/duck/skills/bankr' }, existsAll).join(' ')
    expect(s).toContain('--ro-bind-try /duck/skills/bankr /duck/skills/bankr')
  })

  it('defaultRoBinds filters to existing paths only', () => {
    const only = (p: string) => p === '/usr' || p === '/etc/resolv.conf'
    expect(defaultRoBinds(only)).toEqual(['/usr', '/etc/resolv.conf'])
  })
})
