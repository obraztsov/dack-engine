# Secrets & sandboxing

Two concerns that the wall and the firebreak do *not* cover: keeping real credentials out of the
model's reach, and bounding the arbitrary code the harness runs (sensors, workers).

## Where secrets live

Secret **values** never live in `dack.config.yaml`. There are three mechanisms, each with a different
blast radius:

| Mechanism | What it is | Who sees the value |
|---|---|---|
| `secrets_providers` | A harness-owned script that fetches/rotates a short-lived token and prints a JSON env map | Injected into the consumer (a sensor's env, or an MCP server's env/header) — **never** the agent's tool context |
| `secrets` | A map of `name → reference` (e.g. `file:///run/secrets/…`) | Resolved by the harness; e.g. the Soul DID key, which is harness-only |
| `forwarded_env` | A list of env-var **names** | Injected into the agent and sensor environment; values come from the harness process env |

### Secrets providers

A provider is a trusted script the harness runs on demand. It holds the **root** credentials, performs
fetch/refresh/rotation, and emits only a short-lived **bearer**. A consumer references it by name:

- a duty's `secrets: [x]` → the token is injected into that duty's **sensor** env,
- a capability's `auth: { secret: x, env: X_BEARER_TOKEN }` → the token is injected into the **MCP
  server's** env (stdio) or header (http).

In both cases the token reaches the thing that needs it and never the agent's model context. Adding a
new credential is a provider entry plus a script — never a harness change. The provider is the single
place root creds live; everything downstream sees only the bearer.

### `forwarded_env`

Reserved for **recoverable** values (an API key, a handle, a rate limit) — a leak means rotate, not
catastrophe. These are forwarded into the agent's and sensors' environment by name. Anything
catastrophic (the Soul DID key) is deliberately *not* here — it lives in `secrets` as a reference and is
never forwarded, so the model can never sign as the agent itself.

## What the agent can and can't see

- **Capability tokens** (MCP server auth) — never in the agent's context. The server gets the token;
  the model gets the tool.
- **The Soul DID key** — harness-only. It signs the agent's commits and the soul push; the model never
  holds it.
- **`forwarded_env`** — the model's tools run with these in scope, so list only recoverable values.

## Sandboxing the code the harness runs

The wall governs what the **agent** does. It does not touch the other code the harness executes:

- **Sensors** — a duty's fetch script is arbitrary code, and sensors are Reflect-authored (the agent can
  write its own senses). It runs with a **read-scoped** environment: only `PATH` plus the explicitly
  `forwarded_env` names, plus any provider token the duty declared. No secret it didn't ask for.
- **Workers** — delegated subagents run keyless, with no soul/post/settle access, in a throwaway
  workspace (see [workers](workers.md)).

Both are spawned through a single **sandbox seam** (`src/sandbox/`). The default backend runs them on
the host; a Docker backend maps an isolation policy (read-only rootfs, dropped capabilities, no host
mount, bind-mounted workspace) to `docker run`. This is how a worker's shell becomes OS-confined, and
where future sensor-container hardening slots in — without changing the harness logic that uses the
seam.

## Provenance, not trust-by-default

A sensor's output is **data**, never an instruction — the firebreak at Perceive ensures it. And a
sensor script does not get to claim its own trust: the cycle it produces is seeded from
**provenance** — the duty's source (a signed-script hash, a webhook path's tier, or `self` for a pure
cron self-prompt) — so arbitrary sensor code can never raise the trust ceiling of the cycle it feeds.
See [concepts](concepts.md#the-trust-lattice-taint).

## Checklist

- Gitignore `dack.config.yaml`, `/secrets/`, `/identities/`, and any token files.
- Put root credentials behind a `secrets_providers` script; reference the provider, never the value.
- List only recoverable values in `forwarded_env`.
- Keep the Soul DID key in `secrets` (a reference) — never in `forwarded_env`.
