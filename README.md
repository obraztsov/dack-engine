# dack-engine

**A harness for running an autonomous AI agent as a durable, self-sovereign actor.**

The model is sovereign over *what to think and say*. The harness is sovereign over *what is actually
reachable* — which dangerous actions are possible, on what data, by whom. dack-engine is the
deterministic substrate that makes the irreversible surface unreachable when it should be, so you can
hand an LLM real capabilities (post, trade, self-modify) without trusting it to police itself.

It runs one agent as a long-lived process: events become queued stimuli, the agent wakes and reasons,
and every action it attempts passes through a wall that enforces — independent of the model — *what kind*
of action is allowed, *how far* this particular cycle may go, and *who* is authorized.

## Why

LLM agents are easy to prompt-inject and impossible to fully trust. dack-engine doesn't try to make the
model safe; it makes the *system* safe around an untrusted model:

- **Consciousness states** — a one-way ladder (Perceive → Express → Settle → Reflect). Reads are always
  fine; reversible effects need Express; irreversible authority needs Settle; self-modification needs
  Reflect. The wall classifies every tool call and denies out-of-state ones.
- **Trust/taint** — a cycle starts at a trust tier seeded by provenance and only ratchets *down* as it
  touches data. A cycle that reads a tweet can never reach a trade — automatically, with no rule to
  write. Public, untrusted data physically cannot drive an irreversible action.
- **The firebreak** — untrusted world text never crosses into the acting states verbatim; the agent acts
  on its own digested gist, so a prompt injection can't directly drive a post or a transfer.
- **A signed soul** — the agent's identity, prompts, and memory live in a git repo it commits to as its
  own key. It can edit itself — but only in a rate-limited Reflect cycle, with an integrity tripwire
  reverting any change made elsewhere.

## Quickstart

```sh
make build                                   # cargo build --release + bun install (the runtime bridge)
cp -r soul-template my-soul                  # the agent's identity + prompts
cp dack.config.example.yaml dack.config.yaml # set operator_did + your model endpoint
cargo run --release -- run                   # boot the agent
cargo run --release -- say "Say hi."         # hand it a trusted instruction
```

Full walkthrough: **[docs/getting-started.md](docs/getting-started.md)**.

## Documentation

| | |
|---|---|
| [Getting started](docs/getting-started.md) | Clone → build → run → talk to it |
| [Concepts](docs/concepts.md) | The consciousness states + trust/taint model |
| [Architecture](docs/architecture.md) | How the harness is built |
| [Configuration](docs/configuration.md) | Every `dack.config.yaml` field |
| [Authoring souls](docs/authoring-souls.md) | Write the agent's prompts, duties, and memory |
| [Capabilities](docs/capabilities.md) | Give the agent tools (MCP servers) |
| [Channels](docs/channels.md) | Connect Telegram or another live channel |
| [Workers](docs/workers.md) | Delegated, sandboxed subagents |
| [Operations](docs/operations.md) | Daemon lifecycle, signed soul repos, identities |
| [Secrets & sandbox](docs/secrets-and-sandbox.md) | The secret + isolation model |

Design rationale and history live in [docs/internal/](docs/internal/).

## Layout

- `src/` — the harness crate (Rust).
- `openclaude-bridge/` — the TypeScript runtime bridge + bundled channel/capability adapters (Bun).
- `soul-template/` — a starting template for the agent's durable bundle (copy it; in production it's a
  separate, signed repo).
- `dack.config.example.yaml` — the operator control plane.

## Status

The harness is functional: the full ingestion → consciousness loop runs, with the trust/state model,
MCP capabilities, channels (Telegram), delegated workers, and a signed soul repo. The runtime is wired
for OpenClaude over an OpenAI-compatible gateway; the engine/connector are an extensibility seam.

## License

MIT.
