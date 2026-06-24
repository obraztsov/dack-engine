# Capabilities (giving the agent tools)

The agent's tools are **MCP servers** declared by the operator in `dack.config.yaml`. The agent can
never add a capability — that would be self-granting authority. Adding a tool is a config entry plus a
token; never a code change to the harness.

A capability has three independent properties, and all three gate it:

- **`tier`** — what kind of action it is, which decides the consciousness state it runs in.
- **`trust`** — the taint label of the data it puts in play, which decides how far the cycle may then climb.
- **`min_trust`** — the authorization floor: who is allowed to use it.

See [concepts](concepts.md) for the state/trust model; this page is how to wire it.

## The two-sided handshake

A capability reaches a cycle only when both sides agree:

1. **The soul requests it.** A state-prompt lists servers in its `mcp:` frontmatter (e.g.
   `mcp: [twitter]`).
2. **The operator admits it.** `tier_policy.<state>.import` must include that server name.

Then the harness applies the runtime gates: the cycle's current trust must satisfy any `min_trust`, and
the server's tier must be reachable from the running state. Only the survivors are assembled and
offered to the model. This is why a tweet-reading cycle physically cannot be handed a trade tool — the
config never admits it into a `public`-degraded cycle.

An **open** tier (`tier_policy.<state>.mcp_whitelist: false`) additionally lets a state-prompt inline
an arbitrary public, secret-less read MCP — but only ever at read tier; the soul can never inline a
post or settle capability.

## Tiers and the wall

`tier` maps a server's tools to a wall class:

| `tier` | Wall class | Runs in | Example |
|---|---|---|---|
| `read` | Read | every state | balances, prices, search, a 3rd-party signals feed |
| `post` | Post | Express | `mcp__twitter__post`, a Telegram reply |
| `settle` | SettleTx | Settle | `mcp__cove-trading__buy_token`, a transfer |

The wall classifies by the `mcp__<name>__` prefix and enforces the class per state — independent of
what the model attempts.

## Trust (taint)

`trust` is the taint label of the *data* a server puts in play. Calling any of its tools degrades the
cycle to (at most) that tier. The rule that matters in practice:

> Anything touching the public, untrusted world (the X timeline, a 3rd-party API) **must** be
> `trust: public`. A capability over the operator's own data (their wallet) is `trust: self`.

If you mislabel a public-world server as `trust: self`, a cycle that reads it would keep enough trust to
trade or self-edit off untrusted data — the exact failure the taint model exists to prevent. A
soul-inlined MCP is not in the registry, so it always taints `public`.

## Authorization (`min_trust`)

Set `min_trust` to require a floor of caller trust. The server is only assembled for a cycle whose
*current* (post-taint) trust ranks at or above it, re-checked as the cycle degrades. A capability gated
`min_trust: org` is:

- available to an `org`/`self`/`operator_signed` cycle,
- withheld from a `public` cycle,
- **lost mid-cycle** if an `org` cycle reads public data and degrades — the firebreak, for free.

## Locking a capability to per-cycle data (`scope_env`)

`scope_env` injects per-cycle stimulus data into a server's environment so the model can't supply it as
an argument. The canonical use is destination-locking a reply:

```yaml
- name: telegram
  transport: { type: stdio, command: bun, args: [run, openclaude-bridge/telegram-mcp.ts] }
  auth: { secret: telegram_bot, env: TELEGRAM_BOT_TOKEN }
  tier: post
  scope_env: { TELEGRAM_REPLY_CHAT: chat_id, TELEGRAM_REPLY_TO: message_id }
```

The harness reads `chat_id`/`message_id` from the waking stimulus and injects them; the reply tool takes
only `text`. A prompt-injected message cannot redirect the reply anywhere else, because there is no
destination argument to hijack.

## Limiting an endpoint's surface (`tools`)

If a single endpoint serves write tools to every token, set `tools:` to a read-only allowlist and put
the dangerous tools on a separate settle-tier entry with a different token. The wall denies any tool
under the prefix that isn't in the allowlist, fail-closed.

```yaml
- name: cove-read
  transport: { type: http, url: "https://cove.example/api/mcp" }
  auth: { secret: cove_read }
  tier: read
  trust: self
  tools: [get_balance, get_positions, simulate_swap]   # reads only
- name: cove-trading
  transport: { type: http, url: "https://cove.example/api/mcp" }
  auth: { secret: cove_trade }
  tier: settle
  trust: self
  tools: [buy_token, sell_token]                        # writes only, settle-gated
```

## Tokens (secrets providers)

A capability's `auth.secret` names a `secrets_providers` entry — a harness-owned script that fetches and
rotates a short-lived token. The harness runs it and injects the token into the server's HTTP header or
stdio env; the token reaches the server, never the agent's context. The provider holds the root creds;
the agent only ever sees the bearer. Adding a new secret is a provider entry plus a script — see
[docs/secrets-and-sandbox.md](secrets-and-sandbox.md).

## Testing without real effects (`dry_run`)

`dry_run` makes the wall deny a list of tool-name prefixes while still letting the model compose the
call (visible in the runlog). It is tool-level, so you can block `buy_token` while allowing reads and
`simulate_swap`. Use it to exercise the full reasoning path end-to-end without a live trade or post.

```yaml
dry_run:
  enabled: true
  block: [mcp__twitter__post, mcp__cove-trading__buy_token]
```

## Adding a capability — checklist

1. Add an `mcp_servers` entry (name, transport, tier, trust, optional `tools`/`min_trust`/`scope_env`).
2. Add an `auth.secret` + a `secrets_providers` entry if it needs a token.
3. Add the server name to the relevant `tier_policy.<state>.import`.
4. Have a state-prompt request it in its `mcp:` frontmatter.
5. Verify the wall classification with `dry_run` before going live.
