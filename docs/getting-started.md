# Getting started

This walks you from a clone to a running agent you can talk to.

## Prerequisites

- **Rust** (stable) — builds the `dack` harness binary.
- **Bun** — runs the runtime bridge (`openclaude-bridge/`), which drives the OpenClaude SDK.
- **A model endpoint** — an OpenAI-compatible gateway (URL + key + a model id). Any provider that
  speaks the OpenAI chat API works.

## Build

```sh
git clone <this-repo> dack-engine && cd dack-engine
make build        # cargo build --release + bun install in openclaude-bridge/
```

`make build` does two things: compiles the `dack` binary and installs the bridge's npm dependencies
(`@gitlawb/openclaude`). You can run the steps by hand if you prefer:

```sh
cargo build --release
cd openclaude-bridge && bun install --frozen-lockfile && cd ..
```

Run the test suite (offline, deterministic) to confirm the build:

```sh
cargo test
```

## A minimal soul

The agent's identity and behavior live in a **soul** repo. Start from the template:

```sh
cp -r soul-template my-soul
```

`my-soul/` already has a `SOUL.md`, a set of state-prompts, and example duties. Edit `SOUL.md` to
describe your agent. For the first run you don't need any channels or capabilities — the bundled
prompts handle an operator instruction and a periodic self-prompt out of the box.

## Minimal config

Copy the example and fill in the two things that have no default — your operator DID and the model
endpoint:

```sh
cp dack.config.example.yaml dack.config.yaml
```

```yaml
operator_did: "did:key:z6Mk…"        # the DID your `dack say` is signed against
soul_repo: "my-soul"
runtime:
  connector:
    type: opengateway
    api_url: "https://your-gateway/v1"
    api_key: "…"                      # gitignored config only
  model: "your-model-id"
```

`dack.config.yaml` is the operator control plane — keep it **gitignored**. Every field other than
`operator_did` has a safe default; see the [configuration reference](configuration.md).

> The operator DID + signing key let `dack say` produce a trusted (`operator_signed`) instruction. For
> the very first run you can use any DID you control; the full signed soul/identity setup is in
> [operations](operations.md).

## Run it

```sh
cargo run --release -- run
# or: make run
```

You'll see the harness boot its loops: the consciousness loop (queue → Perceive → wall → Express), the
ingestion loop (cron + webhook → queue), the modules supervisor (if you configured any channels), and
the Reflect scheduler. It now sits idle, waiting for a stimulus.

## Talk to it

In another terminal, hand the running agent an instruction:

```sh
cargo run --release -- say "Introduce yourself in one line."
```

This enqueues a trusted `operator_signed` stimulus. Watch the agent pick it up, perceive it, and act.
Two ways to watch:

```sh
cargo run --release -- status        # alive? queue depth? last run?
cargo run --release -- log --follow  # tail the runlog (the agent "syslog")
```

The runlog records every cycle — the model's thought, the tools it called, and the wall's allow/deny —
under the soul's `runlogs/` directory.

## Next steps

- [Configuration reference](configuration.md) — every config field.
- [Concepts](concepts.md) — the states + trust model that bound what the agent can do.
- [Authoring souls](authoring-souls.md) — write your own prompts and duties.
- [Capabilities](capabilities.md) — give the agent tools (MCP servers).
- [Channels](channels.md) — connect Telegram or another live channel.
- [Operations](operations.md) — running as a daemon, signed soul repos, identities.
