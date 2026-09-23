# buzz — reference executable-skill pack

The duck's **outbound** hand on [Buzz](https://buzz.a.pond.city) (a Nostr workspace) plus on-demand media
pull. Inbound (polling channels → stimuli, media awareness) is the separate `buzz-ingress` module; this pack
is what the duck *runs* to answer.

Executable skills are **signed** capability packages the duck invokes via the structured `RunSkillCommand`
tool — not a shell. Each command is a fixed argv template with typed holes, tier/taint-gated at the wall
exactly like an MCP capability. The detached Ed25519 signature over `skill.manifest.yaml` is the
**execute-gate**: an unsigned, tampered, or wrong-signer manifest is **prose-only** — the duck may read it,
never run it.

## Commands

| command | tier | what it does |
|---|---|---|
| `media_get` | read | Pull an attachment (a Buzz `imeta` sha the duck saw) full-res via Blossom into the media dir → a vision block. `produces: media`. |
| `reply` | post | Destination-locked text reply to the channel the cycle was woken on. |
| `send_file` | post | Destination-locked reply that **attaches a stored file** (`messages send --file`). The `--file` command. |

**Destination-lock.** A reply's `--channel` is a `ref` arg filled by the harness from the trusted stimulus
scope (`conversation`), never a model argument — so a cycle can only answer the channel it was woken on. The
model writes the content; the harness routes it.

**Outbound files are confined.** `send_file`'s `attachment` is a model-named **basename**; the harness
resolves it against the media dir (basename + realpath + store-prefix + regular-file), so an outbound file can
only ever be a **stored** file — one a client sent inbound, or one a paperwork agent returned — never an
arbitrary host path. Same confinement as telegram `reply_document` (`mcp/attachments.ts`) and the Rust
`skills::confine_attachment`.

## Install into a soul

```sh
# 1. Copy this pack into your soul's skills root.
cp -r skills/buzz  <your-soul>/skills/buzz

# 2. Provide the buzz CLI the argv templates call (`${SKILL_DIR}/bin/buzz`). Build it from the pond
#    project and drop the binary here (kept out of the manifest signature — only the manifest is signed):
mkdir -p <your-soul>/skills/buzz/bin
cp /path/to/buzz  <your-soul>/skills/buzz/bin/buzz

# 3. Sign the manifest (the execute-gate). Uses identities.soul (or --role operator) from your config.
dack skill sign --dir <your-soul>/skills/buzz --role soul
#   → writes skill.manifest.yaml.sig ; re-run after ANY manifest edit (an edit invalidates the signature).
```

Then admit it to a state prompt that should be able to use it (the soul half of the capability handshake),
provide the `buzz_key` secret (materialized as `BUZZ_PRIVATE_KEY` into the skill process only), and set the
duck's `media_dir` so `send_file`/`media_get` resolve against the same store the ingress writes to.

## Notes

- **Relay** is baked into each argv (`--relay https://buzz.a.pond.city`). Point it elsewhere by editing the
  manifest and **re-signing** — a signed manifest can't be edited in place.
- **Threading**: the reference sends to the channel (which lands in the right conversation). If your buzz CLI
  supports explicit NIP-10 threading, add `"--reply-to", "{in_reply_to}"` to the argv with an
  `in_reply_to: { type: ref, from: in_reply_to }` arg (the stimulus scope carries `in_reply_to`), then
  re-sign.
- **`bin/buzz` is not vendored here** — it is an external CLI with its own release cadence; the manifest only
  references it. Only `skill.manifest.yaml` is covered by the signature.
