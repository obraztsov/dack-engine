# dack-engine

The **DACK actor-scheduler harness** — a Rust implementation of a self-sovereign,
event-driven DAC actor runtime. The harness is the dumb, deterministic *subconscious*
around a rented consciousness substrate (OpenClaude over localhost gRPC); the
intelligence is sovereign, the irreversible surface is bounded below the model.

> **DACK is not a token with an agent — it is a DAC actor that happens to be legible
> enough to launch with a token. Build the primitive, not the demo.** (DAC-context §6)

## Documents
- `DAC-context-for-DACK-builder.md` — *why* the PRD makes the choices it makes.
- `DACK-harness-architecture.md` — the vision / wide design arc.
- `DACK-harness-PRD.md` — the build-oriented, v1-scoped product requirements.
- **`BUILD-PLAN.md` — the formalized, phase-by-phase implementation plan we follow.**

## Layout
- `src/` — the harness crate (single crate, module boundaries; seams are traits).
- `soul-template/` — a template of the duck's durable actor bundle (PRD §3.2). In
  production this is a separate off-VPS Gitlawb repo, not part of this source tree.
- `dack.config.example.yaml` — the operator control plane (PRD §8.2).

## Status
Phase 1 (foundations & domain scaffold) complete: the load-bearing invariants are
encoded as code and covered by tests. See `BUILD-PLAN.md` for what's next.

```sh
cargo test     # 19 invariant/format tests green
cargo build
```
