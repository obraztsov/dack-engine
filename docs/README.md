# dack-engine documentation

Start with **[getting-started](getting-started.md)**, then **[concepts](concepts.md)** to understand
the safety model. The rest are reference and how-to.

### Learn
- **[Getting started](getting-started.md)** — clone → build → run → talk to it.
- **[Concepts](concepts.md)** — consciousness states, trust/taint, the firebreak. The safety model.
- **[Architecture](architecture.md)** — how the harness is built, end to end.

### Build & run
- **[Configuration](configuration.md)** — every `dack.config.yaml` field, with defaults.
- **[Authoring souls](authoring-souls.md)** — `SOUL.md`, state-prompts, duties, memory, skills.
- **[Operations](operations.md)** — CLI reference, daemon lifecycle, soul repos, identities, health.
- **[Deployment](deployment.md)** — containerized + multi-duck (one image, a directory per duck).

### Extend
- **[Capabilities](capabilities.md)** — give the agent tools (MCP servers).
- **[Skills](skills.md)** — signed executable capability packages the agent runs (`RunSkillCommand`).
- **[Channels](channels.md)** — Telegram (images/voice), Buzz, email, attachments, the notify lane.
- **[Workers](workers.md)** — delegated, sandboxed subagents.
- **[Pond manager](pond-manager.md)** — the duck-as-CEO surface over a pond leader.
- **[Secrets & sandboxing](secrets-and-sandbox.md)** — keeping creds out of the model; isolating code.

Release notes: **[../CHANGELOG.md](../CHANGELOG.md)**. Design rationale and history live inline in the
code's module doc comments (`src/`) and across this `docs/` tree.
