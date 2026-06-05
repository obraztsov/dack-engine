# openclaude-bridge

The **TS side of the DACK runtime seam** (PRD §6, BUILD-PLAN Phase 4). A tiny stdio process
the Rust harness (`OpenClaudeClient`) spawns per state invocation. It runs the OpenClaude SDK
`query()` and relays every `canUseTool` permission event back to the Rust **wall** over NDJSON
on stdin/stdout; the model's final JSON message is parsed into the harness `AgentOutput`.

- **Dependency boundary, not a fork.** Imports `@gitlawb/openclaude/sdk` (the bundled public
  entry) as a normal npm dependency — pinned in `package.json` / `bun.lock`. The vendored
  `openclaude-0.15.0/` source tree (used only for the deep-exploration review) is no longer
  coupled to our code and can be removed.
- **SDK-portable.** The `query`/`canUseTool`/`systemPrompt` surface is the one OpenClaude
  forked from Claude Code, so swapping the import for `@anthropic-ai/claude-agent-sdk` is the
  corp / Claude-Code runtime path (PRD §3.4). OpenClaude is kept for multi-provider routing
  (the cost lever).

## Setup

```sh
bun install                      # pulls @gitlawb/openclaude@0.15.0 (bundled SDK)
```

## Run (normally spawned by the harness; manual smoke shown)

```sh
# The harness drives the NDJSON protocol; to drive it by hand against an OpenAI-compatible
# gateway, set the provider env and pipe one invoke line:
OPENAI_API_KEY=…  OPENAI_BASE_URL=https://opengateway.gitlawb.com/v1  OPENAI_MODEL=mimo-v2.5-pro \
  bun run bridge.ts
```

Model selection for an OpenAI-compatible gateway goes via `OPENAI_MODEL` (env), **not**
`options.model` — the SDK resolves `options.model` against its own catalog and rejects gateway
names (see `docs/VERIFICATION.md` "Phase 4").
