import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Point SKILLS_ROOT at a fixture BEFORE importing (the module reads it at load).
const root = mkdtempSync(join(tmpdir(), 'skills-'))
mkdirSync(join(root, 'bankr', 'references'), { recursive: true })
writeFileSync(
  join(root, 'bankr', 'SKILL.md'),
  '---\nname: bankr\ndescription: crypto trading agent\nmetadata:\n  clawdbot:\n    requires: { bins: [bankr] }\n---\n# Bankr\nbody here',
)
writeFileSync(join(root, 'bankr', 'references', 'safety.md'), '# safety')
process.env.SKILLS_ROOT = root

const { splitFrontmatter, requiredBins, skillDir } = await import('./skills-mcp')

describe('skills-mcp helpers', () => {
  it('splits frontmatter into fm + body', () => {
    const { fm, body } = splitFrontmatter('---\nname: x\ndescription: d\n---\nthe body')
    expect(fm.name).toBe('x')
    expect(body).toBe('the body')
  })

  it('extracts requires.bins from both nestings', () => {
    expect(requiredBins({ clawdbot: { requires: { bins: ['bankr'] } } })).toEqual(['bankr']) // Bankr/Hermes ns
    expect(requiredBins({ requires: { bins: ['foo', 'bar'] } })).toEqual(['foo', 'bar']) // direct
    expect(requiredBins({ other: 1 })).toEqual([]) // none
    expect(requiredBins(undefined)).toEqual([])
  })

  it('confines a skill name to the skills root', () => {
    expect(skillDir('bankr')).toBe(join(root, 'bankr')) // real skill
    expect(skillDir('../etc')).toBeNull() // traversal
    expect(skillDir('a/b')).toBeNull() // separator
    expect(skillDir('..')).toBeNull()
    expect(skillDir('nope')).toBeNull() // not a dir
  })
})
