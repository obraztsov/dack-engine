# Executable skills (giving the agent a runnable hand)

An **executable skill** is a *signed* capability package the agent runs — not by opening a shell, but by
calling one structured tool, `RunSkillCommand`, whose arguments the harness verifies and turns into a
fixed `execve`. Each command is a frozen `argv` template with typed holes, classified by `tier` and
`trust` and gated at the wall exactly like an MCP capability. Adding one is signing a manifest and
admitting it to a state prompt; never a harness change.

> **Two different things both called "skills."** A soul's `skills/<name>/SKILL.md` is **prose** —
> reference material the model just *reads* (catalogued in the fresh-wake self-orientation block). An
> **executable** skill is a `skills/<name>/skill.manifest.yaml` the model *runs*. They can live in the
> same `skills/` dir; only the signed manifest is runnable. Everything below is about the executable kind.

See [capabilities](capabilities.md) for the tier/trust/wall model this reuses, and
[concepts](concepts.md) for the state/taint lattice.

## The execute-gate (a signed manifest)

The manifest `skill.manifest.yaml` carries a **detached Ed25519 signature** in a sibling
`skill.manifest.yaml.sig`. Before the harness will run any command, it verifies that signature over the
manifest bytes against the **operator OR the soul DID**. This is the execute-gate:

- **Unsigned, tampered, or wrong-signer ⇒ prose-only.** The model may *read* the YAML like any soul
  file, but every `RunSkillCommand` against it is denied. Editing the manifest changes its bytes, so an
  old signature no longer verifies — a manifest can never be quietly altered in place and still run.
- **Signed-name pinning.** The manifest's `name` is part of the signed bytes *and* must equal its
  directory name (checked at load). A validly-signed manifest therefore can't be lifted into another
  skill's dir to authorize a different set of binaries.

You produce the signature with the CLI:

```sh
dack skill sign --dir <soul>/skills/<name> --role operator|soul
#   parses + structurally validates the manifest, then writes skill.manifest.yaml.sig
#   → re-run after ANY manifest edit; an edit invalidates the old signature.
```

`--role` picks which identity signs (`identities.operator` or `identities.soul` from your config); the
daemon needs only the corresponding public DID to verify. The command refuses to sign a manifest that
doesn't parse and structurally validate — a signature over a malformed pack is worse than useless.

At the wall, a `RunSkillCommand` is also denied outright if executable skills aren't enabled for the
deployment (no skills root) or no trusted signer DID is configured — fail-closed.

## The manifest format

A manifest is a `name` plus a list of `commands`. Each command is one runnable `argv` template:

```yaml
name: buzz                       # MUST equal the directory name (signed-name pinning)
commands:
  - id: reply                    # the id the model names in RunSkillCommand { command }
    tier: post                   # read (any state) · post (Express) · settle (Settle) — gated at the wall
    trust: self                  # taint label of the data — running this FLOORS cycle trust to `self`
    # argv[0] is the PROGRAM. ${SKILL_DIR} → this skill's dir at build time; {hole} tokens → validated args.
    # Spawned via execve, never `sh -c`, so a value's shell metacharacters are inert bytes.
    argv: ["${SKILL_DIR}/bin/buzz", "messages", "send", "--channel", "{channel}", "--content", "{text}"]
    args:
      channel: { type: ref, from: conversation }        # harness-filled from the trusted reply-scope
      text:    { type: string, pattern: "^[\\s\\S]{1,4000}$" }  # model-supplied, anchored full-match
    secret: buzz_key             # materialized into the child env (like MCP auth.secret) — never model-visible
    network: true                # does the sandboxed child get network egress?
```

Fields per command:

| field | meaning |
|---|---|
| `id` | stable command name the model passes as `RunSkillCommand { command }` |
| `tier` | `read` / `post` / `settle` — the wall class, deciding which state may run it |
| `trust` | the taint label of the data it puts in play; running the command floors the cycle's trust to this |
| `argv` | the fixed template. `argv[0]` is the program; `${SKILL_DIR}` and `{hole}` tokens are substituted |
| `args` | a typed schema per `{hole}` (see below) |
| `secret` | optional — a `secrets_providers` name whose value is injected into the child env |
| `network` | optional bool — whether the sandboxed child gets network egress (default off) |
| `produces` | optional — `media` for a command that emits an image (see below) |

**Structural validation** (enforced at parse, so signing a bad pack is impossible and the later argv
build is total): command ids are unique, no `argv` is empty, **every `{hole}` in an `argv` has an `args`
schema**, and **every declared `arg` is used as a hole** — no undeclared holes, no dead schemas.
`${SKILL_DIR}` is not a hole (the `$` prefix marks it as the special dir token).

## Arg types

An `args` entry gives each hole a type. The type decides *who* fills the hole and how the value is
checked — the crux of why an untrusted model can be handed a live command:

| `type` | filled by | validation |
|---|---|---|
| `string` | the model | must **fully match** the anchored `pattern` regex (whole-span, robust to the author's `^`/`$`) — a partial match can't smuggle extra bytes past a length bound |
| `enum` | the model | must be an exact member of a fixed `values` set |
| `ref` | the **harness** (from the trusted stimulus reply-scope, `from: <scalar>`) | the model may **not** supply it — a `ref` arg on the input is rejected |
| `attachment` | the model names a **basename** | the harness confines it to the media dir → the absolute path of a **stored** file; a traversal or missing file is denied |

`ref` is how a **reply is destination-locked**. The reply-scope carries trusted routing scalars the
ingress adapter put on the stimulus (e.g. `conversation`, `in_reply_to`), passed env-only across the
firebreak. A `channel: { type: ref, from: conversation }` means the duck writes only the *content*; the
harness fills the destination. A prompt-injected message has no destination argument to hijack, so a
cycle can only ever answer the channel it was woken on. (Adapter-agnostic — buzz/slack/discord all
populate the same scope scalars; a missing scalar is a fail-closed deny.)

`attachment` is the outbound-file twin: the model names a basename like `invoice.pdf`, and the harness
resolves it against the media dir (basename strips any `../`, then realpath + store-prefix + regular-file
checks), substituting the absolute path. So an outbound file can only ever be a **stored** file — one a
client sent inbound, or one a worker returned — never an arbitrary host path. This mirrors the Telegram
`reply_document` confinement (`mcp/attachments.ts`); the Rust and TS egress paths confine identically.

Because every value lands as a **separate `argv` element under `execve` (never `sh -c`)**, shell
metacharacters, `$(…)`, backticks, and newlines in a value are inert bytes — the string validation is
*semantic* (length, shape), not a defense against shell injection, which is structurally impossible here.

## `produces: media` (a command that returns an image)

A read command can fetch an image instead of text. It declares `produces: media` and writes its output
to the `${MEDIA_OUT}` argv token. The model **never names that path** — the harness fixes it under the
media dir, deriving a cache filename from the (pattern-validated) `ref` arg (basename + charset-filtered
+ length-capped, so repeat fetches of the same id reuse one file and nothing escapes the dir). On a
successful exec the bridge reads exactly that file back and turns it into a **vision block** on the next
turn.

```yaml
  - id: media_get
    tier: read
    trust: public                # arbitrary external image bytes → untrusted; floors the cycle to public
    argv: ["${SKILL_DIR}/bin/buzz", "media", "get", "{ref}", "-o", "${MEDIA_OUT}"]
    args:
      ref: { type: string, pattern: "^[0-9a-f]{64}(\\.thumb)?\\.(png|jpe?g|gif|webp)$" }
    produces: media
    secret: buzz_key
    network: true
```

A media command must carry **both** the `${MEDIA_OUT}` token *and* a `ref` arg (the id that becomes the
cache filename) — the two are validated in lockstep at parse: `produces: media` without `${MEDIA_OUT}` is
rejected, and a stray `${MEDIA_OUT}` on a non-media command is rejected too, so a media command can't
silently lose its output target.

## The wall: how a command is admitted

`RunSkillCommand` is gated on its own path because its class comes from the **signed manifest**, not the
tool name. On each call the wall:

1. **verifies the signature** (the execute-gate) and builds the argv via `skills::authorize` — any
   failure (traversal in the skill name, bad signature, unknown command, a failed arg check, a
   model-supplied `ref`) is a deny with a reason the model can act on;
2. maps the command's `tier` to a wall class (`read`→Read, `post`→Post, `settle`→SettleTx) and applies
   the **same per-state scope gate as any capability** — a `post` command runs only in Express, a
   `settle` command only in Settle, each reachable only within the cycle's taint ceiling;
3. honors **dry-run** — a synthetic block id `RunSkillCommand:<skill>/<command>` lets an operator hold a
   specific command (e.g. a real post) while letting reads through;
4. **materializes the declared `secret`** lazily via the secrets broker into the child's env (a missing
   broker or failed fetch denies, fail-closed) — the value reaches the executable, never the model;
5. returns the harness-built argv for the bridge to `execve`.

The command's `trust` then floors the cycle just as an MCP capability's `trust` does: a `media_get`
tagged `trust: public` degrades the cycle to `public`, forfeiting any authority above it.

## Authoring & installing a pack

1. **Lay out the pack** at `<soul>/skills/<name>/`: the `skill.manifest.yaml`, plus any program the argv
   templates call (e.g. `bin/<tool>`). Only the manifest is signed — the binary has its own release
   cadence and is kept out of the signature.
2. **Sign it**: `dack skill sign --dir <soul>/skills/<name> --role operator|soul`. Re-sign after any
   edit to the manifest.
3. **Admit it** to a state prompt that should be able to use it (the soul half of the capability
   handshake), so `RunSkillCommand` is offered in that state.
4. **Provide any `secret`** it declares (a `secrets_providers` entry), and set the duck's `media_dir` so
   `attachment`/`produces: media` resolve against the same store the ingress writes to.

The shipped reference is **`skills/buzz/`** (`skill.manifest.yaml` + `README.md`) — the duck's outbound
hand on Buzz, with three commands: `media_get` (`produces: media`), a destination-locked `reply`, and
`send_file` (a destination-locked reply that attaches a confined stored file). It ships **unsigned** for
the adopter to `dack skill sign`.

## Why this is safe to hand an untrusted model

- **No shell.** Commands are `execve`'d fixed templates; a value's shell metacharacters are inert bytes,
  so shell injection is structurally impossible — no `sh -c` exists to inject into.
- **Signed manifest gates execution.** Only an operator- or soul-signed manifest runs; unsigned,
  tampered, or wrong-signer packs are prose-only, and signed-name pinning stops a valid signature being
  reused for a different dir.
- **Destinations are harness-routed.** `ref` args come from the trusted reply-scope (the model can't
  supply them), and `attachment` args are confined to the media store — a reply lands only where the
  cycle was woken, and an outbound file can only be a stored file.
- **Tier × taint gating at the wall.** A command runs only in a state its `tier` reaches, and its
  `trust` floors the cycle — identical to an MCP capability, so a contaminated cycle physically loses
  its post/settle skills.
- **Secrets never reach the model.** A command's `secret` is materialized into the child process env at
  approve-time; the credential reaches the executable, never the model context.
