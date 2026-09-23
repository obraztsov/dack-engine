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
make build                                            # cargo build --release + bun install (the bridge)
dack keygen --role operator --dir identities/operator # native Ed25519 identity → prints your did:key
git clone https://github.com/obraztsov/dack-soul.git my-soul   # the agent's prompts + memory template
cp dack.config.example.yaml dack.config.yaml          # set operator_did (from keygen), soul_repo, model
dack run                                               # boot the agent  (binary: target/release/dack)
dack say "Say hi."                                     # hand it a trusted, signed instruction
```

Identities are native Ed25519 keys (`dack keygen`) — no external key service.

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
| [Skills](docs/skills.md) | Signed executable capability packages (`RunSkillCommand`) |
| [Channels](docs/channels.md) | Telegram (incl. images/voice), Buzz, email, attachments, notify |
| [Workers](docs/workers.md) | Delegated, sandboxed subagents |
| [Pond manager](docs/pond-manager.md) | The duck-as-CEO surface over a pond leader |
| [Operations](docs/operations.md) | Daemon lifecycle, soul repos, identities, health |
| [Deployment](docs/deployment.md) | Containerized + multi-duck (image = code, per-duck volume) |
| [Secrets & sandbox](docs/secrets-and-sandbox.md) | The secret + isolation model |

Design rationale lives inline in the code's module doc comments (`src/`) and across the
[docs/](docs/) tree.

## Layout

- `src/` — the harness crate (Rust).
- `openclaude-bridge/` — the TypeScript runtime bridge (Bun) that talks to the model.
- `mcp/` — the bundled channel/capability adapters (Telegram, Buzz, email, notify, …) and channel
  ingress modules the harness supervises.
- `recall-mcp/` — the short-term-memory recall servers (split public / self by trust).
- `skills/` — reference executable-skill packs (e.g. `skills/buzz/`) an operator copies into a soul.
- `secrets-providers/` — reference secret-materialization scripts.
- `dack.config.example.yaml` — the operator control plane.

A starting template for the agent's durable bundle provided separately (copy it into a soul directory;
in production it's a separate, signed repo).

Release notes live in **[CHANGELOG.md](CHANGELOG.md)**.

## Status

The harness is functional and runs in production: the full ingestion → consciousness loop, the
trust/state model, MCP capabilities, **signed executable skills**, channels (Telegram — with images and
voice —, Buzz, email, and X), **bidirectional file attachments**, a separate **operational-notification**
lane, delegated workers, and a signed soul repo. It is **multithreaded** (independent conversations
process concurrently; a conversation and any memory-writing cycle serialize), keeps short-term memory in a
**SQLite** runlog, and ships a **containerized, multi-duck** deployment (one image, a directory per duck).
The runtime is wired for OpenClaude over any OpenAI-compatible endpoint (an in-house `duck-loop` engine is
in progress); the engine/connector are an extensibility seam. See [CHANGELOG.md](CHANGELOG.md) for the
0.2.0 feature set.

## License

MIT.
