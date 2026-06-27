import { test, expect } from 'bun:test'
import { parseOutput, extractJsonObjects } from './parse'

test('single clean object parses unchanged (the normal path)', () => {
  const out: any = parseOutput('{"thought":"t","transition":{"to_prompt":"express","reason":""}}')
  expect(out.thought).toBe('t')
  expect(out.transition.to_prompt).toBe('express')
})

test('multi-object (the live bitconnect drop) keeps the real transition via later-wins merge', () => {
  // obj1 = gist only (NO transition); obj2 = the complete decision WITH the transition. Before the
  // fix this fell back to to_prompt=null → the Telegram reply silently never sent.
  const text =
    '{"thought":"vibe","memory_append":null,"proposal":{"intent":"reply","gist":"BITCONNEEEECT"}},' +
    '{"thought":"vibe2","proposal":{"intent":"reply","gist":"BITCONNEEEECT"},"spawn":null,' +
    '"transition":{"to_prompt":"telegram/express","reason":"match energy"}}'
  const logs: string[] = []
  const out: any = parseOutput(text, (m) => logs.push(m))
  expect(out.transition.to_prompt).toBe('telegram/express')
  expect(logs.join(' ')).toContain('multi-object')
})

test('NDJSON (newline-separated) objects are both extracted', () => {
  expect(extractJsonObjects('{"a":1}\n{"b":2}').length).toBe(2)
})

test('array-wrapped objects are extracted', () => {
  expect(extractJsonObjects('[{"a":1},{"b":2}]').length).toBe(2)
})

test('braces inside strings do not break extraction', () => {
  const objs = extractJsonObjects('{"gist":"a } b { c","transition":{"to_prompt":"x"}}')
  expect(objs.length).toBe(1)
  expect(objs[0].transition.to_prompt).toBe('x')
})

test('fenced single object still parses', () => {
  const out: any = parseOutput('```json\n{"thought":"f","transition":{"to_prompt":null}}\n```')
  expect(out.thought).toBe('f')
})

test('multi-object batons are CONCATENATED, not dropped (later-wins would lose some)', () => {
  // The model split its fan-out across two JSON objects — both batons must survive.
  const text =
    '{"thought":"a","batons":[{"to_prompt":"telegram/express","reply_to":"10","gist":"A"}]}\n' +
    '{"thought":"b","batons":[{"to_prompt":"telegram/express","reply_to":"20","gist":"B"}]}'
  const out: any = parseOutput(text, () => {})
  expect(out.batons.length).toBe(2)
  expect(out.batons.map((b: any) => b.reply_to)).toEqual(['10', '20'])
})

test('total garbage logs loudly and terminates (to_prompt null), never silently', () => {
  const logs: string[] = []
  const out: any = parseOutput('the model rambled with no json at all', (m) => logs.push(m))
  expect(out.transition.to_prompt).toBe(null)
  expect(out.thought).toContain('rambled')
  expect(logs.join(' ')).toContain('PARSE-FAIL')
})
