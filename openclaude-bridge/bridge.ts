/**
 * DACK ↔ OpenClaude bridge — the thin TS process the Rust `OpenClaudeClient` spawns.
 * Imports the OpenClaude SDK as a normal npm dependency (`@gitlawb/openclaude/sdk`, the
 * bundled public entry), so this project is self-contained and the runtime seam is a clean
 * dependency boundary — not coupled to a vendored source tree.
 *
 * Protocol = NDJSON over stdio:
 *   Rust → bridge (stdin):
 *     {"kind":"invoke","system_prompt":..,"user_prompt":..,"disallowed_tools":[..],
 *      "allowed_tools":null,"model":..}
 *     {"kind":"decision","tool_use_id":..,"allow":bool,"message":..}   (per permission)
 *   bridge → Rust (stdout):
 *     {"kind":"permission","tool":..,"tool_use_id":..,"input":{..}}    (each canUseTool)
 *     {"kind":"result","output":{..AgentOutput..}}                     (once, at the end)
 *     {"kind":"error","message":..}
 *
 * The wall lives in Rust: every `canUseTool` event is relayed and blocks on the Rust
 * decision. Structured output = the model's FINAL message is a JSON object matching the Rust
 * `AgentOutput` (provider-agnostic; an MCP `submit` tool perturbed provider routing).
 * Run: `bun run bridge.ts`. SDK portability: swapping the import below for
 * `@anthropic-ai/claude-agent-sdk` is the corp / Claude-Code runtime path (PRD §3.4).
 */

import * as readline from 'node:readline'
import { query } from '@gitlawb/openclaude/sdk'

// Protect the stdout protocol channel: any stray console.log (incl. the SDK's) → stderr.
console.log = (...a: unknown[]) => console.error('[bridge:log]', ...a)

const emit = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + '\n')

const OUTPUT_INSTRUCTION =
  'When you have finished perceiving and taking any permitted actions, your FINAL message ' +
  'MUST be ONLY a single JSON object (no prose, no markdown fence) with exactly this shape: ' +
  '{"thought": string, "memory_append": string|null, ' +
  '"proposal": {"intent": "reply"|"post"|"research"|"ignore"|"noop", "gist": string}|null, ' +
  '"transition": {"to_state": "perceive"|"express"|"settle"|"reflect"|null, "reason": string}}. ' +
  'Output nothing after the JSON.'

/** Ensure the parsed/fallback output satisfies the Rust AgentOutput contract. */
function normalize(o: any, fallbackText: string): unknown {
  const out = o && typeof o === 'object' ? { ...o } : {}
  if (typeof out.thought !== 'string') out.thought = fallbackText.trim().slice(0, 2000) || '(no output)'
  if (!out.transition || typeof out.transition !== 'object') out.transition = { to_state: null }
  return out
}

/** Extract the AgentOutput JSON from the model's final text (tolerant of fences/prose). */
function parseOutput(text: string): unknown {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence && fence[1]) t = fence[1].trim()
  try { return normalize(JSON.parse(t), text) } catch {}
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return normalize(JSON.parse(t.slice(start, end + 1)), text) } catch {}
  }
  return normalize(null, text)
}

const pending = new Map<string, (d: { allow: boolean; message?: string }) => void>()
let started = false

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line: string) => {
  const t = line.trim()
  if (!t) return
  let msg: any
  try { msg = JSON.parse(t) } catch { return }
  if (msg.kind === 'invoke' && !started) {
    started = true
    runInvoke(msg).catch((e) => {
      emit({ kind: 'error', message: String(e?.message ?? e) })
      process.exit(1)
    })
  } else if (msg.kind === 'decision') {
    const resolve = pending.get(msg.tool_use_id)
    if (resolve) { pending.delete(msg.tool_use_id); resolve(msg) }
  }
})

async function runInvoke(inv: any) {
  const options: any = {
    cwd: process.cwd(),
    systemPrompt: { type: 'custom', content: `${inv.system_prompt}\n\n${OUTPUT_INSTRUCTION}` },
    disallowedTools: inv.disallowed_tools ?? [],
    // The wall: relay every tool to Rust and block on its decision.
    canUseTool: async (name: string, input: unknown, opts?: { toolUseID?: string }) => {
      const tool_use_id = opts?.toolUseID ?? globalThis.crypto.randomUUID()
      emit({ kind: 'permission', tool: name, tool_use_id, input })
      const decision = await new Promise<{ allow: boolean; message?: string }>((resolve) =>
        pending.set(tool_use_id, resolve),
      )
      return decision.allow
        ? { behavior: 'allow', updatedInput: input as any }
        : { behavior: 'deny', message: decision.message ?? 'denied by DACK wall' }
    },
  }
  if (inv.model) options.model = inv.model
  if (inv.allowed_tools) options.allowedTools = inv.allowed_tools

  let finalText = ''
  for await (const m of query({ prompt: inv.user_prompt, options }) as AsyncIterable<any>) {
    if (m?.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const b of m.message.content) if (b.type === 'text') finalText += b.text
    } else if (m?.type === 'result' && m?.result) {
      finalText ||= m.result
    }
  }

  emit({ kind: 'result', output: parseOutput(finalText) })
  process.exit(0)
}
