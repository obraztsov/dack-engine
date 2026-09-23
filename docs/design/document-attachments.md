# Document & attachment capabilities — research + architecture decision

Status: RESEARCH / DECISION · 2026-09-12
Scope: let dack-engine deliver and receive file/document attachments with clients (PDF/docx/xlsx),
and decide where the heavy "paperwork" (parsing, generation, forms) runs.

---

## 1. The ask

Clients of the (openclaude) live dack keep asking for document flows in **both directions**:
- **Hotel operator agent** → prepares a **PDF invoice** and emails it to the guest. *(generate + send, via email)*
- **Clinic administrator agent** → sends a client a **PDF questionnaire**, then **processes the filled return**.
  *(generate + send, then receive + extract structured data)*

Hard requirement (operator): **dack-engine must process attachments in both directions** — regardless of where
the processing logic ultimately lives.

---

## 2. Current state (evidence-backed inventory)

**Today dack handles only images inbound, and nothing outbound.**

| Direction | Channel | Works today | Gap |
|---|---|---|---|
| In | Telegram | photos → media dir; voice → transcribed to text | **no `document` branch** (`telegram-ingress.ts` only reads `m.photo`/`m.voice`) |
| In | Buzz | image bytes (opt-in prefetch); **doc *metadata* awareness** (filename/mime/sha via `imeta`) | doc **bytes never fetched** — `prefetchMedia` drops non-images (`buzz-ingress.ts:143`); `media_get` image-ext-locked (`skills/mod.rs:618`) |
| In | harness → model | images only | `MediaKind::Image` is the **sole** variant (`runtime/mod.rs:84-86`); `media.rs` rejects non-image mime |
| Out | Telegram | **text only** (`sendMessage`) | no `sendPhoto`/`sendDocument` anywhere |
| Out | Buzz | **text only** | the buzz CLI *can* `messages send --file` (→ Blossom + imeta) but **no skill command wires `--file`** |
| Both | Email | **nothing** | no SMTP/IMAP/provider code exists — channel absent |

Runtime/worker layer:

| Layer | Documents today | Gap size |
|---|---|---|
| openclaude bridge | images only; non-image mislabeled `image/jpeg` (`bridge.ts:215-224`) | SMALL (add `document` branch) — but blocked by wire, below |
| openclaude SDK | **full native PDF subsystem** (`readPDF`→`document` block; `pdftoppm`→image pages; Read handles pdf/img/ipynb) **BUT** the OpenAI-compat converter **silently drops `document` blocks** (`sdk.mjs:239296-239307`) | BIG (protocol constraint) |
| duck-loop message model | **image only** (`message.ts:19`); no document type; 3 translators emit image only | BIG (ripples to translators) |
| duck-loop Read | **rejects** pdf/binary outright (`builtins.ts:38-93`) | MEDIUM/BIG |
| **duck-loop executable skills** | a **signed skill can execve a doc CLI and return ≤16 KB text TODAY** (`skills.ts:70-106`), narrowed env | **SMALL** (author+sign a pack) |
| duck-loop skill *produced files* | images only (`Produces::Media`; PDF sniffed-out, `skills.ts:116-129`) | MEDIUM |
| **workers (Docker)** | **arbitrary Bash** in a throwaway workspace (`state/mod.rs:167-174`) | fully capable executor |
| worker image | **no** poppler/tesseract/LibreOffice/python doc libs (`Dockerfile.worker`) | SMALL (one apt/pip layer) |
| **worker artifact return** | **text summary only** across the firebreak; produced files stranded on disk (`harness/mod.rs:2263-2279`) | **BIG** (firebreak is text-only + untrusted by design) |

---

## 3. Two hard constraints that shape the whole decision

**C1 — Native PDF-to-model is blocked on the live wire.** The live duck (and the pond-e2e duck) talk to
**Xiaomi mimo via the OpenAI-compatible wire**. Both runtimes' converters emit only `image` parts and
**drop `document` blocks** (openclaude `sdk.mjs:239296`; duck-loop `translate.ts`/`responses.ts`). The
openclaude SDK *has* a whole native-PDF path, but it's dead on this backend. ⇒ On Xiaomi, a model can only
"see" a document via **(a) extract-to-text** or **(b) render-to-images** (poppler → vision blocks). **Native
PDF document blocks require a Claude/Anthropic endpoint** — which only a *specialist* agent need run.

**C2 — In-duck workers can't *deliver* a produced file.** A Docker worker can run any doc tooling, but its
result crosses the firebreak as an **untrusted text summary**; a generated PDF is left on disk, with **no
channel back** to the duck or client. Returning a file artifact in-duck = a **BIG** firebreak change.

Together these say: **don't try to make the lean client-facing duck read/write documents natively.** Push
the heavy work where the constraints don't bite.

---

## 4. State of the art (external, Sept 2026)

- **Read:** native Claude `document` block (best, Claude-only) · **MarkItDown** (MS, 29+ formats incl.
  docx/xlsx/pptx, fast, ships `markitdown-mcp`) · **Docling** (IBM, structure/table-preserving, heavier, has
  an MCP) · render-to-images (works on Xiaomi vision) · OCR (tesseract) for scans.
- **Generate:** **WeasyPrint** (HTML→PDF, lightweight, no Chromium, CSS Paged Media — the clean invoice path)
  · `python-docx`/`docxtpl` · LibreOffice headless · Gotenberg (Docker microservice).
- **Email:** inbound via Postmark Inbound / SendGrid Inbound Parse / **Cloudflare Email Workers** (JSON webhook
  *with attachments*) → maps onto our ingress-module+webhook pattern; outbound via a transactional API
  (Postmark/Resend/AgentMail) with attachments → maps onto the send-MCP pattern.
- **Cross-cutting insight:** everyone puts heavy doc tooling in a **worker/specialist**, not the chat agent.
- **Security:** client documents are **untrusted** — indirect prompt injection via PDF/docx text is a real,
  documented attack. Extracted content must ride the **public tier** like images; it is *data*, never
  instructions.

---

## 5. The key separation

Two problems hide inside "support documents" — keep them apart:

- **EDGE I/O (required no matter what):** the client-facing duck must *receive* and *send* files at the
  channel edge (Telegram `document`, email attachments), with a store that carries arbitrary **blobs**, not
  just image-vision-refs. This alone satisfies the "both directions" requirement.
- **PROCESSING / GENERATION (the architecture decision):** *where* the parse/extract/generate/fill logic runs.

---

## 6. Architecture options

### Option A — In-duck paperwork
The client duck ingests the file, runs a doc skill/worker (MarkItDown/WeasyPrint), and delivers the result.
- **Cons (both constraints bite):** C2 — a worker can't return a generated PDF without a BIG firebreak
  change; C1 — the duck's own model can't read a PDF natively on Xiaomi; and it loads the lean client duck
  with a heavy toolchain.
- **Effort:** MEDIUM→BIG (the firebreak artifact-return is the expensive part).

### Option B — Hermes-via-Buzz orchestrator (the operator's concept) — **recommended**
The client duck is an **orchestrator/conduit**; heavy paperwork is delegated to **Hermes**, a pond-deployed
specialist with the full toolchain.
```
client ──(telegram doc / email attachment)──▶ client-duck ──(Buzz media upload, Blossom)──▶ Hermes
                                                   ▲                                            │
        client ◀──(telegram sendDocument / email)──┘◀──────(Buzz media: returned artifact)─────┘
                                         Hermes: MarkItDown/Docling · WeasyPrint · LibreOffice · tesseract
                                                 (and may run a Claude model → NATIVE PDF, sidesteps C1)
```
- **Why it wins:** **avoids C2** (the artifact travels over **Buzz media** agent-to-agent — which we already
  shipped P0–P3 — not the text-only worker firebreak); **sidesteps C1** (a Claude-backed Hermes gets native
  PDF fidelity the Xiaomi duck can't); keeps the client duck lean; clean **trust isolation** (untrusted client
  docs are parsed inside an isolated specialist, never in the CEO duck); reuses Buzz + pond infra.
- **Cons:** needs a capable Hermes on pond + a small Buzz file-transfer generalization; a cross-agent
  round-trip (latency); two agents to operate.
- **Effort:** MEDIUM (mostly wiring + Hermes tooling).

### Recommendation — **Hybrid**
1. **Build the EDGE I/O regardless** (§7 Phases 0–2) — it's the operator's hard requirement and both options
   need it.
2. **Delegate generation + complex processing to Hermes via Buzz** (Option B) — the heavy lifting, where C1/C2
   don't bite.
3. **Keep a light in-duck extraction skill** for *simple* reads ("answer a question from this PDF"):
   a signed skill that shells MarkItDown/`pdftotext` and returns ≤16 KB of text — this **works today** with no
   engine change. Reserve Hermes for generation, complex forms, docx, OCR, and native-PDF fidelity.

---

## 7. Build phases (with effort from the inventory)

> **Progress (2026-09-22):** decision locked — heavy processing → Hermes/workers (tested later); now building
> channel-agnostic bidirectional attachment I/O; email next (Cloudflare Email Workers).
> **Done:** telegram `m.document` inbound (`a92426c` — image-as-file → vision, doc → `attachments`; the
> operator's "files don't work" fix); telegram `reply_document` **outbound** (`353413f` — send-by-`attachment_id`,
> harness `MEDIA_DIR` + shared path-confined `attachments.ts`); buzz document inbound (`5301dda` — opt-in
> `media_prefetch_docs` → routable stored `file`); buzz `--file` **full outbound path** (`a789c94`
> `ArgSchema::Attachment`, confined + the reference pack `skills/buzz/` whose `send_file` command wires
> `messages send --file {attachment}` with a destination-locked `--channel`); **email channel**
> (`email-send-mcp.ts` outbound `reply_email` + `email-ingress.ts` inbound + `cloudflare/email-worker.js`,
> §7b). **Contract:** `attachments:[{file,mime,filename,size,kind}]` inbound;
> `attachment_id`/`{type:attachment}` (basename, harness-confined via shared `attachments.ts` /
> `confine_attachment`) outbound. **Next:** wire the email config + deploy the Cloudflare Worker; test
> tg+buzz attachments end-to-end; then Hermes e2e.


- **P0 — Blob-carrying media store + Buzz file transfer.** Generalize the harness media store beyond
  `MediaKind::Image` to an opaque stored **blob** (file the duck can *route/attach* without pushing it as a
  vision block); relax Buzz `prefetchMedia`/`media_get` off the image-only filter (a `file_get`); wire a Buzz
  `send_message --file` skill command (the CLI already supports it). *MEDIUM.*
- **P1 — Client INBOUND file ingress.** Telegram `m.document` → media dir (sibling of the photo path);
  an `email-ingress` module (Postmark/Cloudflare inbound webhook → attachments → media dir). *SMALL–MEDIUM.*
- **P2 — Client OUTBOUND file egress.** Telegram `sendDocument` (multipart) as a destination-locked send
  tool; an `email-send` MCP with attachments (scope-locked recipient, like `telegram-send`). *SMALL–MEDIUM.*
- **P3 — Light in-duck extraction skill.** Signed pack: `markitdown`/`pdftotext` → text. *SMALL, today.*
- **P4 — Hermes paperwork specialist (pond).** Doc toolchain in its image (MarkItDown/Docling, WeasyPrint,
  LibreOffice, tesseract); a "paperwork" skill/flow; Buzz file transfer both ways; optionally a Claude model
  for native-PDF reads. *MEDIUM.*
- **P5 (optional) — Render-to-images path** for visual docs on Xiaomi (poppler `pdftoppm` → vision blocks),
  reusing the media pipeline we already built. *SMALL–MEDIUM.*

Minimal first demo (hotel invoice): **P0 + P2-email + P4** (Hermes generates the invoice PDF, returns over
Buzz, duck emails it). Clinic questionnaire adds **P1** (receive the filled form) + P4 extraction.

---

## 7b. Email channel wiring (Cloudflare inbound + transactional outbound)

Email reuses the whole attachment core — it's just another channel adapter.

**Inbound** (`mcp/cloudflare/email-worker.js` → `mcp/email-ingress.ts`):
- A **Cloudflare Email Worker** on the duck's domain (Email Routing → "send to a Worker") parses each inbound
  email (postal-mime) and POSTs `{from, subject, text, message_id, attachments:[{filename,mime,content(b64)}]}`
  to the `email-ingress` module, authenticated with a shared `X-Email-Ingress-Secret`.
- **email-ingress** (a harness module) verifies the secret (constant-time), stores each attachment to the
  media dir (image → vision `media`; document → routable `attachments`), classifies trust by sender
  (`operator_email` → `/email/op`, else `/email/pub`), and POSTs a stimulus with the reply-scope scalars
  (`email_reply_to`, `email_subject`, `email_in_reply_to`) so a reply is destination-locked.
- Topology: the Worker is external → the module must be reachable from Cloudflare (pond proxy route or a
  tunnel). The module listens on `listen_port`.

**Outbound** (`mcp/email-send-mcp.ts`): a stdio MCP `reply_email{subject?, text, attachment_id?}`,
destination-locked to `EMAIL_REPLY_TO` (harness-injected scope_env), attachment confined via the shared
`resolveAttachment`. Provider-agnostic: `EMAIL_API_URL` + `EMAIL_API_KEY` + `EMAIL_FROM`, Resend-shaped body
(swap to Postmark/SendGrid/MailChannels by URL+key). Cloudflare Email Workers can't *send*, so outbound uses
a transactional API. (Proactive `send_email{to,…}` behind an allow-list = a later privileged server.)

**Config sketch** (`dack.config.yaml`):
```yaml
webhooks: { "/email/op": self, "/email/pub": public }
mcp_servers:
  - name: email
    transport: { type: stdio, command: bun, args: [run, mcp/email-send-mcp.ts] }
    tier: post
    trust: self
    scope_env: { EMAIL_REPLY_TO: email_reply_to, EMAIL_SUBJECT: email_subject, EMAIL_IN_REPLY_TO: email_in_reply_to }
    env: { EMAIL_API_URL: "https://api.resend.com/emails", EMAIL_FROM: "hello@yourduck.tld" }
    auth: { secret: email_api, env: EMAIL_API_KEY }
modules:
  - name: email-ingress
    command: [bun, run, mcp/email-ingress.ts]
    secrets: [email_ingress]   # → EMAIL_INGRESS_SECRET
    env: { EMAIL_INGRESS_CONFIG: "…/email-ingress.config.json" }
```
Later: pond.city per-agent addresses (a shared Worker + per-duck routing); standalone first.

## 8. Decision needed from the operator

1. **Adopt Option B (Hermes-via-Buzz) as the heavy-paperwork path?** (Recommended.) Or keep everything
   in-duck (Option A) and pay the firebreak cost?
2. **First client channel — Telegram document I/O, or Email?** (The hotel-invoice case *requires* email.)
3. **Email provider** — Postmark (structured inbound + send) / Cloudflare Email Workers (cheapest, free
   inbound) / Resend / self-hosted SMTP?
4. **Should Hermes run a Claude model** for native-PDF fidelity, or stay on Xiaomi + extract/render?

The "both directions" requirement (P0–P2) proceeds regardless of 1–4; those choices only shape where the
paperwork engine lives and how the client is reached.
