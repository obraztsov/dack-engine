# Agent workspace, documents over Buzz, and the end of in-duck workers

Status: DESIGN FOR REVIEW · 2026-10-13 · supersedes the "in-duck paperwork" half of
`document-attachments.md` (its constraints C1/C2 and the Hermes-via-Buzz recommendation still hold).

## 0. Why now — three findings from the live loopers (2026-10-12/13)

**F1 — "the verdict doc is in looper-onboarding docs" was a path on another agent's disk.** At 08:21Z
Jarvis (Hermes) posted in `research`: *"Verdict written to `/opt/data/looper-onboarding/docs/MULTIPASS-MAPPING-VERDICT.md`
(uncommitted, per scope)."* looper383's memory kept the path; at 19:35Z its Perceive baton said *"Doc at
/opt/data/looper-onboarding/docs/…"* and the Express rewrote it for the room as *"Full verdict doc is at
`MULTIPASS-MAPPING-VERDICT.md` in looper-onboarding docs."* No relay object exists: `repos list` for the duck
and for 383 is empty, Jarvis's five repo announcements are his, the relay `looper-onboarding` repo is empty, and
the CLI's `mem` store (a relay-side memory, NIP-OA-attested) was never called by either duck (0 uses, all time).
**No loophole** — a file on Jarvis's host, uncommitted by Jarvis's own account, laundered into "docs" by a
summary. The fix is structural: documents agents exchange must travel over the relay (a repo commit or a
message attachment), and an agent must be able to *hold* such a document — which is this design.

**F2 — outbound file attachments have never landed.** Every `write_attachment` → `send_file` pair the
loopers ever ran (383: Oct 6 16:35 research, Oct 8 20:00 c-level, Oct 9 19:53 research; 370: Oct 11 17:11
looper-onboarding) produced **no message on the relay** in its window and no file in the duck's `media/` store;
370 even noted *"full doc sits in memory/drafts/… ready to share once file staging works"* — and each Express
thought still narrated *"brief shipped / attached"*. The MCP logs the failure to stderr, which no runlog
records (the known per-tool-result gap, deferred #4). Inbound Telegram documents DO work (Oct 6: three `.md`
docs from the operator, both ducks `read_attachment` all three and answered on their content). No Buzz wake
has ever carried `attachments`/`media` (0, all time). So: inbound Telegram ✓, inbound Buzz ✗ (never
exercised), outbound anywhere ✗ (fails silently). First build step is a controlled, operator-approved test
post that proves `messages send --file` on this relay, with the failure made visible.

**F3 — the bash duck's sandbox writes into the soul tree.** looper370's `bash` MCP has
`BASH_WORKSPACE: sandbox/work` (relative; MCP cwd is the soul) → `<soul>/sandbox/work`, untracked, not
ignored → the post-step tripwire deletes whatever a Settle step produced there. The workspace below replaces
this directory and ends the class of bug.

## 1. Scope

1. **Remove in-duck subagent workers** (Phase 10/14). Hermes and the other Buzz agents are the delegation
   targets; the worker firebreak (text-only completion, no artefact return — constraint C2) made workers
   unable to hand back a document anyway.
2. **Give the duck a WORKSPACE**: one scratch directory per duck, outside git, wall-controlled, read-only in
   Perceive, writable in Express/Settle/Reflect, trust-capped on touch, trust-gated on write.
3. **Documents through the workspace**: inbound attachments land in it, the duck authors files in it with the
   ordinary file tools, sends any file from it (Buzz / Telegram / email), fetches Buzz media into it, and
   **clones / commits / pushes Buzz git repos in it through a Buzz MCP** — never a shell.
4. **Verify the trust model end to end** (§4), closing two pre-existing gaps found in the survey.

Out of scope (unchanged): PDF/Word extraction (C1 — the model's wire can't take them; forwardable, not
readable), images (stay on the vision lane in `media/`), email channel wiring.

## 2. The workspace

### 2.1 Where it lives — DECISION A

Two placements satisfy "untracked in his soul":

| | **A1 — sibling of the soul: `/duck/workspace/`** (recommended) | A2 — inside the soul: `<soul>/workspace/`, gitignored |
|---|---|---|
| git | Never seen by the soul repo. No `.gitignore` edit, no boot check, `reconcile_with_remote`/`reset --hard` can't touch it. | Must be gitignored or the tripwire commits it to the PUBLIC soul (an untracked file *inside* writable_dirs is committed and pushed). Needs the same boot hard-fail the old `workspaces/` had. |
| pathless `Grep`/`Glob` from the soul cwd | Cannot reach it. A workspace read is always an explicit path → the taint rule (§4.1) is exact. | Reaches it unless ripgrep honours `.gitignore` (unverified for the SDK's Grep); taint would have to be conservative or trust the ignore. |
| wall | `write_target_allowed` gets a second root (`workspace_root`), ~10 lines. | Add `workspace/` to writable_dirs, lexical relativize already works. |
| model ergonomics | Orientation prints the absolute path; prompts say "your workspace is `/duck/workspace`". | Relative `workspace/…` paths. |
| other processes | MCP servers get `WORKSPACE_DIR` (absolute) like `MEDIA_DIR`. Same in both. | same |

Recommendation **A1**. The soul stays a pure git tree (identity + memory), the workspace is harness-owned state
like `media/` and `runlogs.sqlite`. Config: `workspace_dir: workspace` (harness-cwd-relative, default), the
same convention as `media_dir`.

### 2.2 Layout

```
/duck/workspace/
  inbox/      ← harness/ingress-written: inbound documents (telegram docs, buzz prefetch, media_fetch)
  outbox/     ← convention only: what the duck intends to send (any workspace path is sendable)
  repos/      ← git clones made by the buzz-git MCP (one dir per <owner-short>/<repo>)
  <anything>  ← scratch
```
`inbox/` is where ingresses write; the wall treats it like the rest (writable in Express), so the duck may
tidy it. Retention: a configurable sweep (`workspace_retention_days`, default 30) for `inbox/` only; nothing
else is ever auto-deleted (a clone or a draft the duck made is its own to remove).

### 2.3 States

| state | workspace | mechanism |
|---|---|---|
| Perceive | read-only | unchanged: scope `[Read, Net]`, `FileWrite` denied; reads allowed by path (§4.3) |
| Express / Settle / Reflect | read-write | `workspace_root` added as a second allowed write root in `write_target_allowed` |
| parallel (read-lock) prompts | read-only | they clear writable_dirs today; the workspace follows the same rule (a parallel step must not race another's files) |

### 2.4 Tools the duck uses on it

- **Native file tools** (`Read`/`Write`/`Edit`/`Grep`/`Glob`) — the workspace is just a directory. This retires
  `outbox.write_attachment` (the duck writes a file) and `media-read.read_attachment` for text (the duck reads
  the file). Both tools can stay one release for prompts in flight, then go.
- **Send from it**: `buzz-cli.send_file { path, text, channel? }`, `telegram.reply_document { path }`,
  `email.reply_email { attachment }` take a **workspace-relative path**, confined by realpath-prefix to
  `WORKSPACE_DIR` (the `resolveAttachment` logic, root changed). The plaintext-only gate on *sending* goes:
  a duck may forward a PDF it received or a binary a repo contains. The gate stays on *reading into context*.
- **Fetch into it**: `buzz-cli.media_fetch` → `inbox/`; ingresses write documents to `inbox/`.
- **Git on it**: §3.

## 3. Buzz git through an MCP (`buzz-git`)

Jarvis proved the transport on 2026-10-12: the relay is real git smart-HTTP at
`https://<relay>/git/<owner-pubkey-hex>/<repo-id>`, auth is NIP-98 (kind 27235, `u` = repo base URL,
`method`, nonce), ACL = membership of the repo's bound channel. The buzz CLI has no clone verb. So:

**`mcp/buzz-git-mcp.ts`** — `tier: post`, `trust: org`, `min_trust: org` (same auth/env as buzz-cli:
`BUZZ_PRIVATE_KEY`, `BUZZ_RELAY_URL`, `WORKSPACE_DIR`). Runs the system `git` with `execFile` (no shell) and a
**credential helper** that signs NIP-98 with the duck's key (port of Jarvis's `git-credential-buzz.py`/
`nip98.py` to TypeScript, in-process — the key never touches argv or disk).

| tool | does | guards |
|---|---|---|
| `repo_clone { owner, repo, dir? }` | `git clone <relay>/git/<owner>/<repo> repos/<dir>` | `owner` = 64-hex **or a channel/member name resolved via the channel index**; remote URL is constructed, never model-supplied; `--depth 50` default; size cap (`GIT_HTTP_MAX_REQUEST_BUFFER`, post-clone du check, default 200MB); `core.hooksPath=/dev/null`, `protocol.allow=never` for anything but https, `--no-recurse-submodules` |
| `repo_pull { dir }` | fetch + ff-only merge | same |
| `repo_status { dir }` / `repo_diff { dir, path? }` / `repo_log { dir, n }` | read | output caps like execBuzz |
| `repo_commit { dir, message, paths? }` | `git add` (named paths or all) + commit | author = duck handle + a no-reply address, signed-off line with the duck pubkey |
| `repo_push { dir }` | push current branch to origin | origin only (the clone's URL); the relay's channel ACL decides; result echoes the relay's answer |
| `repo_create { id, channel, name? }` | `buzz repos create` + bind | reuses buzz-cli's deny policy (`projects delete` etc. stay denied) |

Everything is **inside `repos/`**: `dir` is a basename, realpath-checked under `WORKSPACE_DIR/repos`. The duck
edits files with `Write`/`Edit` (wall-gated, Express+), then commits/pushes with the MCP. Patches/PRs via the
existing `buzz patches`/`pr` verbs can now be *generated from a real diff* (`repo_diff` → `pr open`).

The teaching: *delegate heavy generation to Hermes; receive the result as a commit you can clone, or an
attachment you can hold — never as a path on someone else's disk* (F1).

## 4. Trust model — verification

The harness's trust is a lattice; a cycle's trust is `meet(directive, payload)`, degraded post-step by what it
touched (`accessed_trust`), and the ceiling (`reaches(trust)`) bounds which states it may enter. Today
**builtin Read/Grep/Glob never taint** and **builtin Read is not confined to the soul** (`../dack.config.yaml`
is readable by the wall's rules). The workspace adds a trust boundary, so both get fixed here.

### 4.1 Touching the workspace caps the cycle — `workspace.read_trust_cap` (default `org`)

- A tool call whose path resolves under `WORKSPACE_DIR` — builtin `Read`/`Grep`/`Glob`/`Write`/`Edit`, or any
  `buzz-git` tool — marks the step `touched_workspace`. Classification gets the path for the read tools too
  (today only writes carry one). A **pathless** `Grep`/`Glob` runs from the soul cwd and cannot reach a sibling
  dir (A1), so it does not mark.
- After the step: `trust = meet(trust, workspace.read_trust_cap)`, `ceiling = reaches(trust)` — exactly how a
  public MCP taints today. Recorded on the runlog entry (`accessed: workspace`).
- **Why a cap rather than a per-file label:** files arrive from many provenances (a public Telegram doc, an
  org clone, the duck's own draft) and provenance is not stable under the duck's own edits. One directory,
  one tier, operator-configurable: `org` by default (a fleet workspace), lowerable to `public` for a duck
  whose inbox is the open world. A cap of `self` is refused at config validation (the workspace is never
  self-trust: untrusted bytes land in it).
- **Same-step limit (unchanged class):** taint is post-step. A single Express step that reads a workspace
  file and posts in the same invocation is not stopped; the next step and every baton are. On the org rails
  this is moot (trust is already org); it matters only with a `public` cap on an org cycle — document, don't
  engineer (an in-step gate would need the wall to know the model's remaining plan).

### 4.2 Writing needs trust — `workspace.write_min_trust` (default `org`)

In `wall_for`: `workspace_writable = lattice.permits(cycle_trust, workspace.write_min_trust)`; the pre-call
gate denies `FileWrite` under the workspace otherwise (a new step 2c beside the `memory/` long-term gate 2a).
So a public cycle (a stranger's Telegram message) can read the duck's workspace only if the cap allows a
public cycle to be in Express at all, and cannot write into it. `inbox/` writes by the *ingress* are not
model tool calls and are not gated — they are the untrusted input itself, which is why §4.1 caps on read.

### 4.3 Reads are confined — fix the pre-existing gap

Builtin `Read`/`Grep`/`Glob`/`LS` targets must resolve under **`soul_root` ∪ `workspace_root` ∪ the
runtime's own spill dir** (plus the existing `PRIVATE_DIRS` denies for `runlogs/`, `media/`). Anything else
(`../dack.config.yaml`, `/etc/…`, `/duck/secrets`) is denied with the standard "outside your tree" message.
Lexical + realpath (follow the symlink, then prefix-check) so a planted symlink in the workspace cannot
redirect a read or a write out of it.

What the loopers actually read outside the soul (all time, 975 + 1141 read-class calls): **(a)** the
OpenClaude SDK's own tool-result spill files, `/root/.openclaude/projects/<soul>/<session>/tool-results/…`
(~30 + ~43 reads) — the SDK writes an oversized tool result to disk and the model reads it back; this is
legitimate and MUST stay allowed (the third root above, taken from the runtime's home); **(b)** mistaken
soul paths, `/duck/memory/goals.md`, `/duck/skills/…`, `Glob /duck` (fail today, will be denied with a
clearer message); **(c)** 383 reading `/opt/data/<the operator's three docs>.md` nine times — Jarvis's host
paths from F1, tried as if local. Nothing legitimate outside those three roots.

### 4.4 Secrets and egress

- `buzz-git` signs in-process; `git` sees a credential helper, never the key. The helper is the MCP itself
  (`GIT_ASKPASS`/`credential.helper` pointing at a tiny stub that asks the MCP over a pipe), or git's
  `http.extraHeader` set per-invocation with a short-lived NIP-98 token — the latter is simpler and
  Jarvis-proven; the token lives in the child's env for one call.
- Remotes are constructed from `(owner, repo)`; the model never supplies a URL. `protocol.allow` forbids
  `file://`, `ext::` and ssh. Hooks disabled. Submodules not fetched. `.gitattributes` filters not run
  (`-c filter.*.clean=` / `smudge=` unset via `core.attributesFile=/dev/null`).
- The buzz CLI's host-path guard has two holes found in the survey: `patches send --patch-file <PATH>` and
  `pr open --body-file <PATH>` read arbitrary host files and publish them. Fix: confine both to the workspace
  (same `resolveAttachment` root), as `--file` is confined today.
- Sending from the workspace is an outward act at the sending tool's tier (`post`); nothing changes in how the
  wall sees egress. A file the duck sends is what the duck chose to send — the narrated-action detector sees
  the call like any other.

### 4.5 Bash (looper370) 

`BASH_WORKSPACE` becomes `WORKSPACE_DIR` (absolute) — the bubblewrap sandbox's one read-write mount IS the
workspace. Settle-only as today. This fixes F3 and gives the bash duck git-free scripting over the same files
the git MCP commits. Bash output is text; files it writes are workspace files the wall never sees, so the
§4.1 cap applies to the *next* step via "a bash call touched the workspace" (the bash MCP is registered with
`trust: org`, so it already taints to org).

## 5. Removing the workers

From the survey (file:line in the engine): `src/agent_def.rs` (whole); `Intent::Delegate`, `SpawnRequest`,
`AgentOutput.spawn` in `model/proposal.rs`; dispatch spawn block + `InvocationRequest.{agents,isolate,mounts}`
+ the worker section (`run_worker_detached`, reaper, `enqueue_worker_completion`) in `harness/mod.rs`;
`worker_spec` and Reflect's `agents/` writable dir in `state/mod.rs`; `WorkerBackend`/`with_worker`/
`worker_env`/`isolate` branch in `runtime/openclaude.rs`; the Agent/Task "return spawn" teaching in
`action_required.rs` (→ plain deny); `RuntimeConfig.worker_sandbox` (keep as a deprecated, ignored field so a
live `dack.config.yaml` with `worker_sandbox:` still parses — the prod duck has one); `build_worker_backend`
and `sweep_stale_workspaces` in `cli/mod.rs`; `ExecKind::Worker`; bridge `spawn` instruction + agents-based
disallow (→ unconditional `Task`,`Agent` deny) + `SandboxedBash`; duck-loop `spawn` field; `Dockerfile.worker`;
soul-template `agents/` + prompt passages; `docs/workers.md` and the eleven doc mentions. `DockerSandbox`
stays (sensors use it). `ToolClass::Shell/Other` stay in the enum.

The duck-loop runtime (our own loop) keeps parity: its `spawn` output field goes too.

## 6. Documents — what changes for the model

| today | after |
|---|---|
| `outbox.write_attachment { name, text }` (128KB, text only, flat `media/`) | `Write` a file under the workspace |
| `media-read.read_attachment { attachment_id }` (text, 64KB, untrusted wrapper) | `Read` the file (workspace read ⇒ org cap); keep the tool one release as an alias |
| `send_file { attachment_id }` by basename in `media/` | `send_file { path }` — any workspace file |
| inbound docs → `media/<chat>_<msg>_<id>.ext`, GC 7d | → `workspace/inbox/<channel>/<original-filename>` (dedup suffix), retention 30d |
| Buzz docs: prefetch into `media/` (images) | images unchanged (vision lane); documents → `inbox/` |
| "results come back in the channel" | **results come back as a commit (clone it) or an attachment (it's in your inbox)** |

Payload: `attachments[].file` becomes the inbox-relative path. No new payload fields; `attachments` already
exists on telegram/email/buzz bodies.

## 7. Build phases

| # | what | proves |
|---|---|---|
| 0 | **Controlled send test**: one operator-approved `messages send --file` from a duck to `ideas` (or a DM), with the MCP result surfaced in the runlog `sent`/`tool result` line (closes deferred #4 for *this* tool first: send tools record `ok/err` + relay event id in the runlog entry) | F2 root cause; the relay accepts imeta uploads from a duck |
|   | **RESULT (2026-10-13):** two probes from looper370 to `ideas`, `.md` and `.txt`: `upload failed … unsupported file type: application/octet-stream` — the CLI sniffs magic bytes, text has none, and it REFUSES octet-stream client-side; nothing was posted. The relay accepts octet-stream (the operator's desktop app attached an `.md` with `m application/octet-stream` the same hour). ⇒ F2's root cause is the buzz CLI's `--file` type gate, a pond-project fix (accept `text/*` + octet-stream, or `--mime`). Phase 2 proceeds on the workspace paths; text sends over Buzz stay blocked until the CLI accepts them (the Telegram and email sends are unaffected). | |
| 1 | Workspace dir + config (`workspace_dir`, `read_trust_cap`, `write_min_trust`, retention) + wall: write root, read confinement (§4.3), workspace taint (§4.1), write gate (§4.2); orientation line; tests for every rule | the trust model, in unit tests before any tool uses it |
| 2 | Document path migration: ingresses → `inbox/`; `send_file`/`reply_document`/`media_fetch` on workspace paths; buzz-cli `--patch-file`/`--body-file` confinement; outbox/media-read kept as aliases | inbound+outbound documents on Telegram and Buzz, end to end on the live loopers |
| 3 | `buzz-git` MCP: clone/pull/status/diff/log/commit/push/create with NIP-98 in-process; looper-template teaching (SKILL.md: "receive work as a commit"); 370's bash sandbox → workspace | a duck clones Jarvis's repo, edits a doc, commits, pushes; Jarvis pulls |
| 4 | Worker removal (engine, bridge, duck-loop, docs, soul-template) | `cargo test`, `bun test`, boot of both loopers unchanged |
| 5 | Prompts: delegation = Buzz agents; documents = workspace; drop every "worker"/"spawn" passage | the ducks use it: a brief → Hermes → a commit → cloned → reviewed |

Phase 4 is independent of 1–3 and can go first if you prefer the deletion out of the way.

## 8. Decisions needed

- **A. Placement:** A1 sibling `/duck/workspace` (recommended) vs A2 inside the soul, gitignored.
- **B. Defaults:** `read_trust_cap: org`, `write_min_trust: org`, `inbox` retention 30 days, `self` cap refused.
- **C. Read confinement (§4.3)** — a tightening for all souls: builtin reads limited to soul ∪ workspace.
- **D. Git identity:** commits authored as `Looper #<id> <looper-<id>@<relay-host>>` with a `Buzz-Pubkey:` trailer; pushes only to origin.
- **E. Aliases:** keep `write_attachment`/`read_attachment` one release, or remove with the workers.
- **F. Phase order:** 0→1→2→3→4→5 as above, or workers-first.
