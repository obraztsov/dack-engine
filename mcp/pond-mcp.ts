/**
 * pond-management — the duck's CEO surface over the pond (stdio MCP, sibling of `telegram-mcp.ts`).
 * Executes every verb as HTTP against the leader's `/v1/manager` plane with the ACTING USER's identity
 * attached below cognition:
 *
 *   - `POND_ACTING_TG_ID` is scope_env-injected by the harness from the waking Telegram update's
 *     authenticated `from.id` — the model has NO user-id argument to forge, so the duck can only ever
 *     act on agents the person in front of it owns (the leader 404s everything else; we surface that
 *     as "you have no such agent", never as an existence oracle).
 *   - `MANAGER_JWT` (auth-injected) is the leader credential; it never appears in tool results.
 *   - Plane-C secrets the leader returns (configurator URLs, one-time credentials) NEVER enter the
 *     model: they are minted into owner-bound single-use handles (`pond-store.ts`); the model forwards
 *     the opaque `H-…` token in its reply and the telegram egress splices the real value at delivery.
 *
 * Deliberately NOT here (control-plane-only or nonexistent by design): logs, restore, migrate, delete,
 * exec, re-bind, choose-recipient, read-secret-value. Do not add them.
 *
 * stdout is the MCP protocol channel — NEVER log to it; use stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { AGENT_NAME_RE, LeaderError, leaderClient, type AgentRow } from './pond-leader'
import { mintHandle, openPondStore } from './pond-store'

const acting = process.env.POND_ACTING_TG_ID?.trim() || null
const leader = leaderClient() // reads POND_LEADER_URL / MANAGER_JWT / POND_ACTING_TG_ID
const store = process.env.INGRESS_DB ? openPondStore(process.env.INGRESS_DB) : null

const asText = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }] })

/** Model-facing slice of an AgentRow — enough to reason and report, no registry internals. */
function agentView(a: AgentRow) {
  return {
    name: a.name,
    template: `${a.template_id}@${a.template_version}`,
    mode: a.mode,
    desired_state: a.desired_state,
    observed_state: a.observed_state,
    observed_at: a.observed_at,
    backup_window:
      a.backup_window_start != null && a.backup_window_end != null
        ? `${a.backup_window_start}:00-${a.backup_window_end}:00 UTC (retention ${a.backup_retention})`
        : null,
    created_at: a.created_at,
  }
}

/** Uniform error surface. 404 = "not yours" (the id-gate IS the filter); 409 messages are written for
 *  the end user — pass them on verbatim. */
function explain(e: unknown, agentName?: string) {
  if (e instanceof LeaderError) {
    if (e.status === 404 && agentName)
      return { ok: false, error: `you have no agent named '${agentName}'` }
    if (e.status === 409) return { ok: false, error: e.message, tell_user: true }
    if (e.code === 'unreachable' || e.status === 502)
      return { ok: false, error: 'the pond control plane is unreachable right now — try again shortly' }
    return { ok: false, error: e.message }
  }
  return { ok: false, error: String((e as any)?.message ?? e) }
}

function requireActing():
  | { ok: true }
  | { ok: false; error: string } {
  if (!acting)
    return {
      ok: false,
      error: 'no acting user in scope — pond management only works in a chat woken by an attested user',
    }
  return { ok: true }
}

type ToolResult = { content: { type: 'text'; text: string }[] }
const guard = (fn: () => Promise<unknown>) => async (): Promise<ToolResult> => {
  const g = requireActing()
  if (!g.ok) return asText(g)
  try {
    return asText(await fn())
  } catch (e) {
    return asText(explain(e))
  }
}
// Same, for tools that take an agent `name` (maps 404 → "you have no such agent").
const guardNamed =
  <A extends { name: string }>(fn: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<ToolResult> => {
    const g = requireActing()
    if (!g.ok) return asText(g)
    try {
      return asText(await fn(args))
    } catch (e) {
      return asText(explain(e, args.name))
    }
  }

const server = new McpServer({ name: 'pond-management', version: '0.1.0' })
const name = z.string().regex(AGENT_NAME_RE, 'lowercase letters/digits/hyphens, starts alphanumeric, ≤32 chars')

server.registerTool(
  'credits',
  {
    description:
      "The acting user's pond account: credit balance, daily cost across their agents, days left, and " +
      'the recent ledger (last 20 charges/top-ups). Check this before creating agents or when the user ' +
      'asks about billing.',
    inputSchema: {},
  },
  guard(() => leader.credits()),
)

server.registerTool(
  'list_templates',
  {
    description:
      'Agent templates the pond offers right now, with price in credits/day. An empty list usually means ' +
      'the pond is briefly unreachable — say so rather than "there are no templates".',
    inputSchema: {},
  },
  guard(async () => {
    const t = await leader.listTemplates()
    return t.length ? { ok: true, templates: t } : { ok: true, templates: [], note: 'pond briefly unreachable — retry shortly' }
  }),
)

server.registerTool(
  'list_agents',
  {
    description:
      "The acting user's agents (only theirs — ownership is enforced below you). Optional filters: " +
      'state (running|stopped|paused), template id.',
    inputSchema: { state: z.string().optional(), template: z.string().optional() },
  },
  async (a: { state?: string; template?: string }) => {
    const g = requireActing()
    if (!g.ok) return asText(g)
    try {
      const rows = await leader.listAgents(a.state, a.template)
      return asText({ ok: true, count: rows.length, agents: rows.map(agentView) })
    } catch (e) {
      return asText(explain(e))
    }
  },
)

server.registerTool(
  'agent_status',
  {
    description:
      "One agent's registry row + live pond detail (health/stats), if it belongs to the acting user. " +
      '`pond: null` means the pond could not be queried just now. Note: desired vs observed state can ' +
      'lag while the pond converges — this is the tool to poll.',
    inputSchema: { name },
  },
  guardNamed(async ({ name }) => {
    const d = await leader.getAgent(name)
    return { ok: true, agent: agentView(d.registry), pond: d.pond }
  }),
)

server.registerTool(
  'create_agent',
  {
    description:
      'Create an agent for the acting user (ownership is stamped from their attested identity — you ' +
      'cannot create for anyone else). Charges the first day up front; on insufficient credits you get ' +
      'a message written for the user — relay it verbatim. NEVER collect secret values in chat: create ' +
      'first, then use enter_configurator for secrets/config. If the response contains secret_handles ' +
      '(pond-generated one-time credentials, e.g. a dashboard password), forward each H-… handle to the ' +
      'user in your reply — the real value is inserted at delivery, you never see it, and each handle ' +
      'works exactly once, only in this chat, for ~30 minutes.',
    inputSchema: { name, template: z.string().min(1), config: z.record(z.string()).optional() },
  },
  guardNamed(async ({ name, template, config }: { name: string; template: string; config?: Record<string, string> }) => {
    const r = await leader.createAgent(name, template, config ?? {})
    const secretKeys = Object.keys(r.secrets)
    let secret_handles: Record<string, string> | undefined
    if (secretKeys.length) {
      if (!store) return { ok: false, error: 'handle store unavailable (INGRESS_DB not set) — cannot route one-time credentials; agent was created' }
      secret_handles = {}
      for (const [k, v] of Object.entries(r.secrets)) secret_handles[k] = mintHandle(store, v, acting!, 'secret')
    }
    return {
      ok: true,
      agent: agentView(r.agent),
      balance: r.balance,
      ...(secret_handles ? { secret_handles, note: 'forward each handle to the user in your reply; values are spliced in at delivery' } : {}),
    }
  }),
)

for (const [tool, action, blurb] of [
  ['start_agent', 'start', 'Start (or set running)'],
  ['stop_agent', 'stop', 'Stop'],
  ['pause_agent', 'pause', 'Pause'],
  ['resume_agent', 'resume', 'Resume (same as start)'],
] as const) {
  server.registerTool(
    tool,
    {
      description:
        `${blurb} one of the acting user's agents. Sets the DESIRED state; the pond converges (a 200 ` +
        'here is not yet "done" — while the agent is in configurator mode or mid-backup the apply is ' +
        'deferred). Confirm with agent_status.',
      inputSchema: { name },
    },
    guardNamed(async ({ name }) => ({ ok: true, agent: agentView(await leader.lifecycle(name, action)) })),
  )
}

server.registerTool(
  'recreate_agent',
  {
    description:
      "Recreate an agent's container from its current image (config/secrets re-injected; state volume " +
      'untouched). Use when an agent is wedged. For a version upgrade use update_agent instead.',
    inputSchema: { name },
  },
  guardNamed(async ({ name }) => ({ ok: true, ...(await leader.recreate(name)) })),
)

server.registerTool(
  'update_agent',
  {
    description:
      "Update an agent to its template's newest image and recreate it. SLOW — the pond pulls the image " +
      'synchronously and this call can take minutes; tell the user it is in progress before calling, ' +
      'and poll agent_status after. `image_changed: false` means it was already newest.',
    inputSchema: { name },
  },
  guardNamed(async ({ name }) => ({ ok: true, ...(await leader.update(name)) })),
)

server.registerTool(
  'enter_configurator',
  {
    description:
      "Flip the acting user's agent into configurator mode for config + secret authoring (the agent is " +
      'OFFLINE meanwhile), and mint a private link for them. You receive an opaque H-… handle, NEVER ' +
      'the link: put the handle in your reply text and the real URL is inserted at delivery, only in ' +
      'this chat, single-use, valid ~30 min. This is the ONLY way secrets are set or read — never ask ' +
      'for secret values in chat. read_only: true mints a view-only session.',
    inputSchema: { name, read_only: z.boolean().optional() },
  },
  guardNamed(async ({ name, read_only }: { name: string; read_only?: boolean }) => {
    if (!store) return { ok: false, error: 'handle store unavailable (INGRESS_DB not set)' }
    // Prefill what the harness attests: the operator/tg id for duck-class forms (PRD §5.4).
    const r = await leader.enterConfigurator(name, { tg_operator_id: acting! }, read_only ?? false)
    const handle = mintHandle(store, r.url, acting!, 'configurator_url')
    return {
      ok: true,
      agent: r.agent,
      read_only: r.read_only,
      handle,
      note: 'include this handle in your reply; the link appears at delivery (single-use, ~30 min, this chat only)',
    }
  }),
)

server.registerTool(
  'cancel_configurator',
  {
    description:
      'Abort a configurator session and flip the agent back to agent mode without applying anything. ' +
      "Use when the user is done/stuck or asked for it — an open session keeps their agent offline.",
    inputSchema: { name },
  },
  guardNamed(async ({ name }) => ({ ok: true, ...(await leader.cancelConfigurator(name)) })),
)

server.registerTool(
  'list_backups',
  {
    description: "An agent's backups (read-only): id, status, size, when taken. Restore is operator-only — do not promise it.",
    inputSchema: { name },
  },
  guardNamed(async ({ name }) => ({ ok: true, backups: await leader.listBackups(name) })),
)

server.registerTool(
  'list_operations',
  {
    description: "An agent's recent backup/restore operations with phase + error (last 20). Use to answer 'did my backup run?'.",
    inputSchema: { name },
  },
  guardNamed(async ({ name }) => ({ ok: true, operations: await leader.listOperations(name) })),
)

server.registerTool(
  'set_backup_policy',
  {
    description:
      'Set an agent\'s daily backup window (UTC hours 0-23, start ≠ end, wrap-around ok) and retention ' +
      '(1-365 days, default 7).',
    inputSchema: {
      name,
      window_start: z.number().int().min(0).max(23),
      window_end: z.number().int().min(0).max(23),
      retention: z.number().int().min(1).max(365).optional(),
    },
  },
  guardNamed(
    async ({ name, window_start, window_end, retention }: {
      name: string
      window_start: number
      window_end: number
      retention?: number
    }) => {
      if (window_start === window_end) return { ok: false, error: 'window_start must differ from window_end' }
      return { ok: true, agent: agentView(await leader.setBackupPolicy(name, window_start, window_end, retention)) }
    },
  ),
)

server.registerTool(
  'clear_backup_policy',
  {
    description: "Remove an agent's backup policy (no more scheduled backups; existing backups kept per retention).",
    inputSchema: { name },
  },
  guardNamed(async ({ name }) => ({ ok: true, agent: agentView(await leader.clearBackupPolicy(name)) })),
)

await server.connect(new StdioServerTransport())
console.error(
  `[pond-mcp] ready; leader=${process.env.POND_LEADER_URL ?? 'http://127.0.0.1:7700'} acting=${acting ?? '(none)'} store=${store ? 'ok' : 'MISSING'}`,
)
