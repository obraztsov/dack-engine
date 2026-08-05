Vendored + patched @gitlawb/openclaude 0.18.0 sdk.mjs.

PATCH 1 (identity prefix): emptied the 3 CLI identity-prefix literals ("You are OpenClaude...") so the
system prompt is ONLY our SOUL.md (no coding-agent framing). filter(Boolean) drops the now-empty strings.

PATCH 2 (SSE spec compliance, 2026-08-05): `readSseEvents` (the /responses + codex stream reader)
required a space after the colon (`startsWith("event: ")`/`"data: "`). The space is OPTIONAL per the
WHATWG EventSource spec (one leading U+0020 is stripped), so a compliant provider that frames
`event:x`/`data:{...}` — e.g. Xiaomi's `/responses` — had EVERY frame dropped → empty assistant text +
`output_tokens:0`. Changed to match colon-only and strip one optional leading space
(`slice(6/5).replace(/^ /,"")`). Backward-compatible with spaced framing (OpenAI/Codex). This is what
makes `runtime.connector.api_format: responses` usable on Xiaomi. Upstream bug (untested vs no-space SSE).

NOT patched here: OpenAI-shim penalty passthrough (needs a source build — deferred). Two remaining
/responses-stream gaps left as-is (Xiaomi doesn't hit them — it emits `output_text.delta`): text is
accumulated only from `response.output_text.delta` (never reconstructed from the terminal
`response.completed` payload), and `response.output_text.done`/`content_part.done` are unhandled.

Pin: 0.18.0. Do NOT npm-upgrade the bridge import past this without re-vendoring (re-apply BOTH patches).
