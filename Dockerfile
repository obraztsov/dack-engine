# The DUCK image — the full mind + channels for ONE duck, CODE ONLY. Per-duck STATE (config, secrets,
# identities, soul, SQLite DBs) is never baked in: it lives in a host directory bind-mounted at /duck
# (the working dir), so a single image serves many ducks.
#
# Build (a DEPLOY step — the harness never builds images at runtime; build native amd64 on the VPS):
#   docker build -t dack/duck:latest .
# Run one duck (outbound-only: telegram long-polls, the webhook is 127.0.0.1 inside the box → NO -p):
#   docker run -d --name <duck> --restart unless-stopped --cpus 2 --memory 3g \
#     -v /srv/ducks/<duck>:/duck dack/duck:latest
#
# REBUILD after any change to src/ (harness) or openclaude-bridge/recall-mcp (bridge/MCP) — both are
# baked in, not bind-mounted (host node_modules/binary are the wrong arch/OS).

# ── Stage 1: build the Rust harness. Bundled SQLite compiles C, so we need a toolchain — bookworm's
#    rust image already ships gcc; no other system libs (deps are pure-Rust, verified). ──
FROM rust:1-bookworm AS build
WORKDIR /build
# Dependency cache: compile the (slow, rarely-changing) dependency graph against a STUB crate first, so
# a source-only edit doesn't recompile every crate on rebuild. The real sources land in the next layer.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
  && echo '' > src/lib.rs \
  && echo 'fn main() {}' > src/main.rs \
  && cargo build --release --locked \
  && rm -rf src
COPY src ./src
# `touch` so cargo sees the real sources as newer than the stub artifacts and rebuilds the crate itself.
RUN touch src/lib.rs src/main.rs && cargo build --release --locked

# ── Stage 2: runtime. bun drives the bridge + recall MCP; python3 runs the (stdlib-only) secrets
#    providers; git+openssh push the soul to GitHub; bubblewrap+socat give the OpenClaude SDK its
#    per-command bash sandbox on Linux WITHOUT docker-in-docker; ca-certificates for TLS egress. ──
FROM oven/bun:1
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       git openssh-client python3 bubblewrap socat ca-certificates \
       ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# The per-duck volume (soul repo + nested runlog repo) is owned by the HOST user (uid 1000), but the
# container runs as root → git refuses it as "dubious ownership", breaking the soul tripwire + push.
# The container is the isolation boundary and every repo under /duck is the duck's own, so trust them.
RUN git config --system --add safe.directory '*'

# The harness binary → on PATH.
COPY --from=build /build/target/release/dack /usr/local/bin/dack

# The bridge + recall MCP: install LINUX node_modules from the committed lockfiles (own layers, cached
# unless deps change), then bake the sources. bun resolves node_modules from each SCRIPT's dir, so the
# runtime cwd (/duck) never matters for resolution.
WORKDIR /app/openclaude-bridge
COPY openclaude-bridge/package.json openclaude-bridge/bun.lock ./
RUN bun install --frozen-lockfile
COPY openclaude-bridge/*.ts ./
# The PINNED + PATCHED SDK the bridge actually imports at runtime (`vendor/openclaude-0.18.0/sdk.mjs`,
# a git-tracked bundled build) — NOT the node_modules copy. node_modules stays for the SDK's external
# requires + grammy (telegram) + the MCP sdk. Missing this → "Cannot find module .../sdk.mjs".
COPY openclaude-bridge/vendor ./vendor

WORKDIR /app/recall-mcp
COPY recall-mcp/package.json recall-mcp/bun.lock ./
RUN bun install --frozen-lockfile
COPY recall-mcp/src ./src

# The trusted secrets providers (python, stdlib-only). No per-duck state — the tokens they read/write
# live in the mounted /duck/secrets/.
COPY secrets-providers /app/secrets-providers

# Per-duck STATE is the bind-mounted volume, and it's the working dir — so the config's relative state
# paths (soul_repo, db_path, runlog_db, secrets, identities) resolve under /duck, while the config
# points at /app/... for the code above. `dack run` defaults to ./dack.config.yaml (→ /duck/…).
WORKDIR /duck
ENTRYPOINT ["dack", "run"]
