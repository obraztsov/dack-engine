Vendored openclaude 0.18.0 `sdk.mjs` — now **BUILT FROM the DACK fork source**, not hand-patched.

The fork (private repo under `obraztsov`; local checkout at repo-root `/openclaude-0.18.0`, gitignored) =
upstream @gitlawb/openclaude 0.18.0 + our patches. See the fork's `PATCHES.md`:

- **PATCH 1** (`src/constants/system.ts`): the 3 coding-agent identity prefixes → `''` (the model's system
  prompt is ONLY our SOUL.md — no "You are OpenClaude, a coding agent…" framing).
- **PATCH 2** (`src/services/api/codexShim.ts` `readSseEvents`): SSE-spec-compliant field parsing — the
  space after the SSE colon is OPTIONAL, so match `event:`/`data:` colon-only and strip one leading space.
  Fixes empty output on providers that frame `event:x`/`data:{...}` without the space (Xiaomi `/responses`).

REBUILD + RE-VENDOR: in the fork, `bun install && bun run build` → `dist/sdk.mjs`; copy it here; then
validate through the bridge (A/B chat + responses via the scratch probes) BEFORE committing. Bundler
module-ordering is nondeterministic (~150 lines differ run-to-run vs the previous bundle) — validate
FUNCTIONALLY, not by diff.

NOT patched: OpenAI-shim penalty passthrough; two minor `/responses`-stream gaps (Xiaomi unaffected — see
the fork `PATCHES.md`).

Pin: 0.18.0 (0.21 added inference-reseller ads + deeper gitlawb/opengateway coupling, no functional gain).
Do NOT npm-upgrade the bridge import — rebuild from the fork instead.
