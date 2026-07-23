# Deployment (Docker + multi-duck)

Running one duck locally is `dack run` in a working tree (see [getting-started](getting-started.md)).
This page is the **container** deployment: one duck (or many) on a server, each isolated, each
reconfigurable by editing its own directory.

The model is **image = code, volume = state**:

- A single shared **image** holds the immutable code — the `dack` binary, the bridge, the recall MCP
  servers, and the runtimes they need. It carries **no** config, secrets, soul, or database.
- Each duck is a **host directory** bind-mounted into its container at `/duck`. It holds that duck's
  `dack.config.yaml`, `secrets/`, `identities/`, `soul/`, adapter configs, and SQLite databases. One
  image serves any number of ducks; a duck is "just a directory".

## Prerequisites

- **Docker** on the host.
- **git** — to clone the engine (to build the image) and to push each soul (from inside the container).
- A model endpoint (as in getting-started) and, per duck, its secrets + identities.

Networking is **outbound-only**: the Telegram adapter long-polls, and the webhook listener binds
`127.0.0.1` *inside* the container, so **no ports are published**. The container needs egress to your
model endpoint, the channel APIs (X, Telegram), your soul git remote, and any HTTP MCP servers.

## Build the image

The `Dockerfile` at the repo root is multi-stage: a `rust` stage builds the harness (bundled SQLite
needs only a C toolchain — no system libs), and an `oven/bun` runtime stage adds `git`, `openssh`,
`python3` (the stdlib-only secrets providers), and `bubblewrap`/`socat` (the SDK's Linux command
sandbox), then bakes the bridge (`openclaude-bridge/`, with `bun install`), the recall MCP
(`recall-mcp/`), and the secrets providers. Build it **natively for the target architecture** (build on
the server, or cross-build with `buildx`):

```sh
git clone <engine-repo> dack-engine && cd dack-engine
docker build -t dack/duck:latest .
```

`.dockerignore` keeps every per-duck state file (config, secrets, identities, soul, databases) out of
the image, so the shared image never contains anyone's secrets.

> The bridge imports a **vendored, pinned** OpenClaude SDK at `openclaude-bridge/vendor/…/sdk.mjs`
> (git-tracked); the Dockerfile copies it. `bun install` also runs, for the SDK's external deps +
> `grammy` + the MCP SDK.

## Lay out a duck's directory

Create `/srv/ducks/<name>/` on the host and populate it (this *is* the `/duck` volume):

```
/srv/ducks/<name>/
  dack.config.yaml            # this duck's config (container variant — see below)
  secrets/                    # x.json, *.token — this duck's secrets
  identities/                 # soul/operator/builder: identity.pem + ucan.json (mode 0600)
  dack-soul/                  # the soul git repo (prompts, memory, stimuli, skills)
  telegram-ingress.config.json # per-duck operator rails (operator id, trusted groups) — optional
  # dack.sqlite, runlogs.sqlite, dack.health.json  ← created on first boot
```

### The container config

The config's **code** paths must point at the image's baked-in `/app`, while **state** paths stay
relative to `/duck` (the container's working dir). `scripts/dockerize-config.sh` rewrites a normal
config into that form (bridge / MCP / secrets-provider commands + `bridge_dir` → `/app/...`; soul,
databases, secrets, identities stay relative). Secret values are untouched; it's idempotent:

```sh
scripts/dockerize-config.sh dack.config.yaml > /srv/ducks/<name>/dack.config.yaml
```

`dack run` defaults to `./dack.config.yaml`, so with the working dir at `/duck` it reads this file.

### Soul push from inside the container

The soul is pushed to a git remote (memory backup, and the source for
[remote-authority reconcile](operations.md#remote-authoritative-soul)). The container runs as root, so
give it a git identity two things need care:

- **A deploy key.** Put the SSH key + `known_hosts` + a `config` (`Host github.com … IdentityFile
  /root/.ssh/id_…`) in a **root-owned** directory (SSH rejects a key owned by another uid when git runs
  as root), and mount it read-only at `/root/.ssh`. A common layout is a shared `/srv/ssh-soul/`.
- **`safe.directory`.** The bind-mounted soul is owned by the host user (uid 1000) but git runs as
  root, so git refuses it as "dubious ownership" — the image sets `git config --system --add
  safe.directory '*'` so the soul tripwire + push work.

## Run a duck

```sh
docker run -d --name <name> --restart unless-stopped \
  --cpus 2 --memory 3g \
  -v /srv/ducks/<name>:/duck \
  -v /srv/ssh-soul:/root/.ssh:ro \
  dack/duck:latest
```

- `--restart unless-stopped` survives reboots/crashes (replaces a `nohup`/systemd wrapper).
- `--cpus`/`--memory` partition the host across ducks; tune `max_concurrent_cycles` per duck to match.
- No `-p`: nothing is published (outbound-only).

Verify:

```sh
docker logs -f <name>                    # boot + per-cycle logs
docker exec <name> dack status           # queue, secret + MCP + duty health
```

A healthy boot logs the duties, `consciousness loop up`, `modules up`, the Telegram adapter
long-polling, and — if `soul_remote_authority` is on — a `soul reconcile` line.

## Update a duck

Deploy is git-driven:

```sh
# on the host that has the engine clone:
cd dack-engine && git pull && docker build -t dack/duck:latest .
docker rm -f <name> && docker run -d --name <name> --restart unless-stopped \
  --cpus 2 --memory 3g -v /srv/ducks/<name>:/duck -v /srv/ssh-soul:/root/.ssh:ro dack/duck:latest
```

The volume (soul, databases, secrets) persists across the recreate. Telegram long-polls, so messages
queued during the brief restart are delivered when it comes back.

To reconfigure a duck's **soul** (prompts/stimuli) without a code change, push to its soul repo and
restart with `soul_remote_authority: true` — the duck adopts the pushed config at boot and keeps its
memory. See [operations → remote-authoritative soul](operations.md#remote-authoritative-soul).

## Multiple ducks

Each duck is a separate directory + container: its own soul, secrets, identities, bot/token, and
`--cpus`/`--memory` slice, all on the one shared image. Give each its own name and `/srv/ducks/<name>`;
they share nothing but the image and the host kernel.

## Notes

- **Workers** (delegated subagents) run on the host *inside* the duck container by default
  (`runtime.worker_sandbox.enabled: false`). Docker-isolated workers would be docker-in-docker and are
  out of scope here.
- **Clock**: the container inherits the host clock; the duck works in UTC — keep the host synced.
