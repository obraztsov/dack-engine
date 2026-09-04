/**
 * Typed client for the leader's manager plane (`/v1/manager/*`) — the ONLY component that speaks to
 * the leader on the duck's behalf. Wire shapes verified against dack-leader `src/api/manager.rs`
 * (2026-08-19); deserialize tolerantly, additive fields will appear.
 *
 * Auth: every data-plane request carries the long-lived manager JWT (`aud: leader, scope:
 * duck:manager`) PLUS `X-Acting-Tg-Id` — the acting user's identity, harness-injected below cognition
 * (`scope_env`), NEVER a model argument. The leader stamps ownership from that header; a stranger gets
 * 404/empty for anything they don't own. The service tier (events/tenants) is the manager's own
 * housekeeping and sends no acting header.
 *
 * Errors: the leader's envelope is `{"error":{"code","message"}}` with code ∈ validation | auth |
 * forbidden | not_found | conflict | upstream | internal. 409 messages are written for the END USER
 * (e.g. the insufficient-credits text) — surface them verbatim.
 */

export type AgentRow = {
  id: number
  name: string
  pond: string
  tenant_id: number | null
  template_id: string
  template_version: string
  mode: string // agent | configurator
  desired_state: string // running | stopped | paused
  observed_state: string | null // running | stopped | paused | missing | …
  observed_at: string | null
  backup_window_start: number | null
  backup_window_end: number | null
  backup_retention: number
  /** Credit-suspended (leader paused it for lack of credits; auto-resumes on top-up). A user-paused
   *  agent has desired_state=paused with suspended=false — different story, tell them apart. */
  suspended: boolean
  created_at: string
  updated_at: string
}

/** Create is ASYNC (202): validate + charge synchronously (credit refusals are immediate 409), then
 *  provision in the background. Completion arrives as an `agent_created` / `agent_create_failed`
 *  journaled event; `GET /operations/{id}` is the durable fallback. Pond-generated one-time secrets
 *  are NOT returned — they surface through the configurator instead. */
export type CreateAccepted = { operation: string; agent: string; status: string; balance: number | null }
export type Operation = {
  operation: string
  kind: string
  status: string // requested | placing | creating | done | failed
  phase: string
  agent: string | null
  error: string | null
  updated_at: string
}
export type AgentDetail = { registry: AgentRow; pond: unknown | null }
export type UpdateResponse = {
  agent: string
  update: { image_before: string | null; image_after: string | null; image_changed: boolean }
}
export type ConfiguratorResponse = { agent: string; url: string; read_only: boolean }
export type BackupRow = {
  id: string
  agent_id: number
  s3_key: string
  size_bytes: number | null
  status: string
  error: string | null
  taken_at: string | null
}
export type OperationRow = {
  id: string
  kind: string
  phase: string
  error: string | null
  created_at: string
  updated_at: string
}
export type TemplateRow = { id: string; credits_per_day: number }
export type Credits = {
  tg_user_id: string
  balance: number
  daily_cost: number
  agents: number
  days_left: number | null
  ledger: { delta: number; balance_after: number; reason: string; created_at: string }[]
}
/** Events are FLAT: `{id, type, tg_user_id, agent, …type-specific fields…}` — identical shape on the
 *  WS fast path and the `/events` replay (replay adds `created_at`), so dedupe-by-id is trivial.
 *  `normalizeEvent` also tolerates the legacy nested-`payload` shape from a pre-flatten leader. */
/** POST /referral/redeem — IDEMPOTENT (the leader grants exactly once; safe to call on every /start).
 *  Terminal `reason`s (stop retrying): already_redeemed | invalid_or_expired_code | self_referral |
 *  plan_inactive | referrals_disabled. Anything thrown (network/5xx) is transient — retry later. */
export type RedeemResult =
  | { redeemed: true; plan: string; referee_bonus: number; referrer_bonus: number; balance: number }
  | { redeemed: false; reason: string }
export const TERMINAL_REDEEM_REASONS = new Set([
  'already_redeemed',
  'invalid_or_expired_code',
  'self_referral',
  'plan_inactive',
  'referrals_disabled',
])

export type MyReferral = {
  code: string
  link: string // https://t.me/<bot>?start=<code> — populated from the LEADER's referral.bot_username
  referred_count: number
  credits_earned: number
  redeemed_welcome: boolean
}

export type EventRow = {
  id: number
  type: string
  tg_user_id: string | null
  agent: string | null
  created_at?: string
  [field: string]: unknown
}

export function normalizeEvent(raw: Record<string, unknown>): EventRow {
  const { payload, ...rest } = raw
  const flat = { ...(payload && typeof payload === 'object' ? (payload as object) : {}), ...rest }
  return flat as EventRow
}

export class LeaderError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

// leader's registry::valid_name (DNS-label shaped, 2026-08-25): 1-31 chars, lowercase alnum + hyphen,
// first AND last char alphanumeric (no trailing hyphen). Check client-side, save a round-trip.
export const AGENT_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,29}[a-z0-9])?$/

export type LifecycleAction = 'start' | 'stop' | 'pause' | 'resume'

export type LeaderClient = ReturnType<typeof leaderClient>

export function leaderClient(opts?: { baseUrl?: string; jwt?: string; actingTgId?: string }) {
  const baseUrl = (opts?.baseUrl ?? process.env.POND_LEADER_URL ?? 'http://127.0.0.1:7700').replace(/\/+$/, '')
  const jwt = opts?.jwt ?? process.env.MANAGER_JWT
  const actingTgId = opts?.actingTgId ?? process.env.POND_ACTING_TG_ID

  async function request<T>(
    method: string,
    path: string,
    o?: { body?: unknown; acting?: boolean; timeoutMs?: number; text?: boolean },
  ): Promise<T> {
    if (!jwt) throw new LeaderError(0, 'config', 'MANAGER_JWT not set — pond management unavailable')
    const headers: Record<string, string> = { Authorization: `Bearer ${jwt}` }
    if (o?.acting !== false) {
      if (!actingTgId) {
        throw new LeaderError(
          0,
          'no_acting_user',
          'no acting user in scope — pond management only works in a cycle woken by an attested user',
        )
      }
      headers['X-Acting-Tg-Id'] = actingTgId
    }
    if (o?.body !== undefined) headers['Content-Type'] = 'application/json'
    let r: Response
    try {
      r = await fetch(`${baseUrl}/v1/manager${path}`, {
        method,
        headers,
        body: o?.body !== undefined ? JSON.stringify(o.body) : undefined,
        signal: AbortSignal.timeout(o?.timeoutMs ?? 30_000),
      })
    } catch (e: any) {
      throw new LeaderError(0, 'unreachable', `leader unreachable: ${e?.message ?? e}`)
    }
    if (o?.text) {
      const t = await r.text()
      if (!r.ok) {
        let j: any = null
        try {
          j = JSON.parse(t)
        } catch {}
        throw new LeaderError(r.status, j?.error?.code ?? 'http', j?.error?.message ?? `leader returned ${r.status}`)
      }
      return t as unknown as T
    }
    const j: any = await r.json().catch(() => null)
    if (!r.ok) {
      const code = j?.error?.code ?? 'http'
      const message = j?.error?.message ?? `leader returned ${r.status}`
      throw new LeaderError(r.status, code, message)
    }
    return j as T
  }

  const qs = (params: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') p.set(k, String(v))
    const s = p.toString()
    return s ? `?${s}` : ''
  }

  return {
    actingTgId,
    // ── data plane (acting header) ────────────────────────────────────────────
    createAgent: (name: string, template: string, config: Record<string, string> = {}) =>
      // secrets ALWAYS {} — secret values are never collected in chat; they go in via the configurator.
      request<CreateAccepted>('POST', '/agents', { body: { name, template, config, secrets: {} } }),
    getOperation: (id: string) => request<Operation>('GET', `/operations/${id}`),
    listAgents: (state?: string, template?: string) => request<AgentRow[]>('GET', `/agents${qs({ state, template })}`),
    getAgent: (name: string) => request<AgentDetail>('GET', `/agents/${name}`),
    lifecycle: (name: string, action: LifecycleAction) => request<AgentRow>('POST', `/agents/${name}/${action}`),
    recreate: (name: string) => request<{ ok: boolean; agent: string }>('POST', `/agents/${name}/recreate`),
    // Synchronous image pull pond-side; the leader waits up to 15 min — match it client-side.
    update: (name: string) => request<UpdateResponse>('POST', `/agents/${name}/update`, { timeoutMs: 16 * 60_000 }),
    enterConfigurator: (name: string, prefill: Record<string, string>, readOnly = false) =>
      request<ConfiguratorResponse>('POST', `/agents/${name}/configurator`, {
        body: { prefill, read_only: readOnly },
      }),
    cancelConfigurator: (name: string) =>
      request<{ ok: boolean; agent: string }>('POST', `/agents/${name}/configurator/cancel`),
    listBackups: (name: string) => request<BackupRow[]>('GET', `/agents/${name}/backups`),
    listOperations: (name: string) => request<OperationRow[]>('GET', `/agents/${name}/operations`), // last 20
    // ── host-level ops on the tenant's own agent ──────────────────────────────
    logs: (name: string, tail = 200) =>
      request<string>('GET', `/agents/${name}/logs${qs({ tail })}`, { text: true }), // plain text, not JSON
    manifest: (name: string) => request<Record<string, unknown>>('GET', `/agents/${name}/manifest`),
    // exec/setup are KATA-gated leader-side (409 on runc — tenant code exec needs hardware isolation).
    exec: (name: string, cmd: string[], user?: string, workdir?: string) =>
      request<{ stdout: string; stderr: string; exit_code: number }>('POST', `/agents/${name}/exec`, {
        body: { cmd, ...(user ? { user } : {}), ...(workdir ? { workdir } : {}) },
        timeoutMs: 120_000,
      }),
    setSetup: (name: string, setup: { cmd: string[]; user?: string; description?: string }[]) =>
      request<Record<string, unknown>>('PUT', `/agents/${name}/setup`, { body: { setup } }),
    listSurfaces: (name: string) => request<unknown[]>('GET', `/agents/${name}/surfaces`),
    // With auth:bearer the response carries a ONE-TIME auth_token — plane-C, handle-store it.
    addSurface: (name: string, surface: Record<string, unknown>) =>
      request<Record<string, unknown>>('POST', `/agents/${name}/surface`, { body: surface }),
    removeSurface: (name: string, surface: string) =>
      request<{ removed: unknown }>('DELETE', `/agents/${name}/surface/${surface}`),
    backupNow: (name: string) => request<{ operation: string; agent: string }>('POST', `/agents/${name}/backup`),
    restore: (name: string, backupId?: string) =>
      request<{ operation: string; agent: string }>('POST', `/agents/${name}/restore`, {
        body: backupId ? { backup_id: backupId } : {},
      }),
    decommission: (name: string) =>
      request<{ outcome: string; agent: string }>('DELETE', `/agents/${name}`),
    // ── referral (Phase 4) ────────────────────────────────────────────────────
    // `code` comes from the harness-captured deep-link param, NEVER model free-text.
    redeemReferral: (code: string) => request<RedeemResult>('POST', '/referral/redeem', { body: { code } }),
    myReferral: () => request<MyReferral>('GET', '/referral'),
    setBackupPolicy: (name: string, windowStart: number, windowEnd: number, retention?: number) =>
      request<AgentRow>('PUT', `/agents/${name}/backup-policy`, {
        body: { window_start: windowStart, window_end: windowEnd, ...(retention != null ? { retention } : {}) },
      }),
    clearBackupPolicy: (name: string) => request<AgentRow>('DELETE', `/agents/${name}/backup-policy`),
    listTemplates: () => request<TemplateRow[]>('GET', '/templates'), // [] can mean "no pond seen in 180s"
    credits: () => request<Credits>('GET', '/credits'),
    // ── service tier (no acting header) ───────────────────────────────────────
    events: async (after: number, limit = 500) =>
      (await request<Record<string, unknown>[]>('GET', `/events${qs({ after, limit })}`, { acting: false })).map(
        normalizeEvent,
      ),
  }
}
