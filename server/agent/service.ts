import { eq, desc } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import { db } from '../db/client.js'
import { agentSessions, agentTranscripts, type AgentSessionStatus } from '../db/schema.js'
import { logger } from '../logger.js'
import { sandboxManager } from '../sandbox/manager.js'
import { anyProviderConfigured } from './providers.js'
import {
  OpenCodeError,
  getOpenCodePassword,
  isOpenCodeReady,
  opencodeBasicAuthHeader,
  resolveEndpoint,
  startOpenCode,
} from './opencode.js'

export class AgentError extends Error {
  constructor(
    public code:
      | 'sandbox_unavailable'
      | 'not_ready'
      | 'no_provider'
      | 'not_found'
      | 'unavailable'
      | 'start_failed',
    message: string,
  ) {
    super(message)
    this.name = 'AgentError'
  }
}

export interface AgentSessionSummary {
  id: string
  sandboxId: string
  opencodeSessionId: string
  title: string | null
  status: AgentSessionStatus
  createdAt: Date
  lastActivityAt: Date
}

export interface PendingApproval {
  id: string
  sessionId: string
  title: string
  pattern?: string | string[]
  metadata: Record<string, unknown>
  createdAt: number
}

export interface TranscriptEvent {
  type: 'message.updated' | 'message.part.updated' | 'permission.updated' | 'permission.replied' | 'session.idle' | 'session.error'
  sessionId: string
  // Forward OpenCode event payload verbatim; UI can render deltas.
  payload: Record<string, unknown>
}

type TranscriptListener = (evt: TranscriptEvent) => void

interface SandboxSubscription {
  listeners: Set<TranscriptListener>
  controller: AbortController | null
  running: boolean
  restartTimer: ReturnType<typeof setTimeout> | null
}

class AgentService {
  private clients = new Map<string, OpencodeClient>()
  private subs = new Map<string, SandboxSubscription>()
  private pending = new Map<string, Map<string, PendingApproval>>() // opencodeSessionId -> permissionId -> req
  private seqCounters = new Map<string, number>() // sessionId (ours) -> next seq
  private wired = false

  /**
   * Subscribe to sandbox lifecycle events so `opencode serve` gets started
   * (or re-started) whenever a sandbox enters an active+running state. Call
   * once at app boot.
   */
  wireSandboxLifecycle(): void {
    if (this.wired) return
    this.wired = true
    sandboxManager.onEvent((evt) => {
      if (evt.type === 'created' || evt.type === 'status_changed') {
        if (evt.status === 'active' || evt.type === 'created') {
          void this.ensureBootstrapped(evt.sandboxId)
        }
      }
      if (evt.type === 'archived' || evt.type === 'deleted') {
        this.clients.delete(evt.sandboxId)
        this.stopSubscription(evt.sandboxId)
      }
    })
  }

  /**
   * Start `opencode serve` for every active sandbox on app boot. Runs after
   * the sandbox reconciler so containers exist. Errors are logged but do not
   * abort — operators can still reach sandboxes without the agent.
   */
  async reconcile(): Promise<void> {
    const list = await sandboxManager.list()
    for (const sb of list) {
      if (sb.status !== 'active' || !sb.running) continue
      await this.ensureBootstrapped(sb.id)
    }
  }

  /** Call from `SandboxManager` create + reconciler. Idempotent. */
  async ensureBootstrapped(sandboxId: string): Promise<void> {
    try {
      const cfg = await anyProviderConfigured()
      if (!cfg) {
        logger.info({ sandboxId }, 'no provider configured; skipping opencode bootstrap')
        return
      }
      const sb = await sandboxManager.get(sandboxId)
      if (!sb || !sb.running) return
      await startOpenCode(sandboxId)
    } catch (err) {
      logger.warn({ err, sandboxId }, 'opencode bootstrap failed')
    }
  }

  async agentStatus(sandboxId: string): Promise<{
    ready: boolean
    hasProvider: boolean
  }> {
    const hasProvider = await anyProviderConfigured()
    const ready = await isOpenCodeReady(sandboxId)
    return { ready, hasProvider }
  }

  /** Explicit user-triggered boot for older sandboxes. Propagates errors. */
  async startAgent(sandboxId: string): Promise<void> {
    const cfg = await anyProviderConfigured()
    if (!cfg) throw new AgentError('no_provider', 'no provider API key configured')
    try {
      await startOpenCode(sandboxId)
    } catch (err) {
      if (err instanceof OpenCodeError) {
        throw new AgentError(
          err.code === 'sandbox_unavailable' ? 'sandbox_unavailable' : 'start_failed',
          err.message,
        )
      }
      throw err
    }
  }

  private async getClient(sandboxId: string): Promise<OpencodeClient> {
    const cached = this.clients.get(sandboxId)
    const ep = await resolveEndpoint(sandboxId)
    if (!ep) throw new AgentError('sandbox_unavailable', 'sandbox is not running')
    if (!(await isOpenCodeReady(sandboxId))) {
      // Try a lazy restart, once.
      await this.startAgent(sandboxId)
    }
    if (cached) return cached
    const client = createOpencodeClient({
      baseUrl: `http://${ep.ip}:${ep.port}`,
      // OpenCode's server enforces Basic auth with username=opencode when
      // OPENCODE_SERVER_PASSWORD is set; Bearer was rejected with 401.
      headers: { Authorization: opencodeBasicAuthHeader(ep.password) },
    })
    this.clients.set(sandboxId, client)
    return client
  }

  private invalidateClient(sandboxId: string): void {
    this.clients.delete(sandboxId)
  }

  async sessionList(sandboxId: string): Promise<AgentSessionSummary[]> {
    const rows = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.sandboxId, sandboxId))
      .orderBy(desc(agentSessions.lastActivityAt))
    return rows.map((r) => ({
      id: r.id,
      sandboxId: r.sandboxId,
      opencodeSessionId: r.opencodeSessionId,
      title: r.title,
      status: r.status,
      createdAt: r.createdAt,
      lastActivityAt: r.lastActivityAt,
    }))
  }

  async sessionStart(input: {
    sandboxId: string
    prompt: string
    title?: string
    model?: { providerID: string; modelID: string }
  }): Promise<AgentSessionSummary> {
    const client = await this.getClient(input.sandboxId)
    const create = await client.session.create({
      body: { title: input.title },
      throwOnError: true,
    })
    const ocSession = create.data
    const id = ulid().toLowerCase()
    const now = new Date()
    const resolvedTitle = input.title ?? ocSession.title ?? null
    await db.insert(agentSessions).values({
      id,
      sandboxId: input.sandboxId,
      opencodeSessionId: ocSession.id,
      title: resolvedTitle,
      status: 'active',
      createdAt: now,
      lastActivityAt: now,
    })

    // Fire the initial prompt (async: don't block returning the id; UI can
    // subscribe to the transcript stream before we return anyway).
    void client.session
      .promptAsync({
        path: { id: ocSession.id },
        body: {
          parts: [{ type: 'text', text: input.prompt }],
          ...(input.model ? { model: input.model } : {}),
        },
      })
      .catch((err) => logger.warn({ err, id }, 'session prompt failed'))

    this.ensureSubscription(input.sandboxId)

    return {
      id,
      sandboxId: input.sandboxId,
      opencodeSessionId: ocSession.id,
      title: resolvedTitle,
      status: 'active',
      createdAt: now,
      lastActivityAt: now,
    }
  }

  async sessionSend(input: { sessionId: string; message: string }): Promise<void> {
    const row = await this.requireSession(input.sessionId)
    const client = await this.getClient(row.sandboxId)
    await client.session.promptAsync({
      path: { id: row.opencodeSessionId },
      body: { parts: [{ type: 'text', text: input.message }] },
      throwOnError: true,
    })
    await db
      .update(agentSessions)
      .set({ lastActivityAt: new Date() })
      .where(eq(agentSessions.id, row.id))
  }

  /**
   * Cold-load the full message history for a session. UI hydrates from this,
   * then switches to the live `transcript` subscription. Messages are returned
   * in OpenCode's canonical order (the SDK response is already sorted).
   */
  async sessionMessages(
    sessionId: string,
  ): Promise<
    Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
  > {
    const row = await this.requireSession(sessionId)
    const client = await this.getClient(row.sandboxId)
    const res = await client.session.messages({
      path: { id: row.opencodeSessionId },
      throwOnError: true,
    })
    return (res.data ?? []) as Array<{
      info: Record<string, unknown>
      parts: Array<Record<string, unknown>>
    }>
  }

  async sessionStatus(input: { sessionId: string }): Promise<{
    session: AgentSessionSummary
    pendingApprovals: PendingApproval[]
  }> {
    const row = await this.requireSession(input.sessionId)
    const pendingMap = this.pending.get(row.opencodeSessionId)
    const pending = pendingMap ? [...pendingMap.values()] : []
    return {
      session: {
        id: row.id,
        sandboxId: row.sandboxId,
        opencodeSessionId: row.opencodeSessionId,
        title: row.title,
        status: row.status,
        createdAt: row.createdAt,
        lastActivityAt: row.lastActivityAt,
      },
      pendingApprovals: pending,
    }
  }

  async sessionRespond(input: {
    sessionId: string
    permissionId: string
    response: 'once' | 'always' | 'reject'
  }): Promise<void> {
    const row = await this.requireSession(input.sessionId)
    const client = await this.getClient(row.sandboxId)
    await client.postSessionIdPermissionsPermissionId({
      path: { id: row.opencodeSessionId, permissionID: input.permissionId },
      body: { response: input.response },
      throwOnError: true,
    })
    const pendingMap = this.pending.get(row.opencodeSessionId)
    pendingMap?.delete(input.permissionId)
  }

  /** Subscribe to forwarded OpenCode events for a specific session. */
  subscribeTranscript(sessionId: string, fn: TranscriptListener): () => void {
    let unsubscribed = false
    let innerUnsub: (() => void) | null = null
    void (async () => {
      const row = await this.requireSession(sessionId).catch(() => null)
      if (!row || unsubscribed) return
      this.ensureSubscription(row.sandboxId)
      const state = this.subs.get(row.sandboxId)!
      const wrapper: TranscriptListener = (evt) => {
        if (evt.sessionId === row.opencodeSessionId) fn(evt)
      }
      state.listeners.add(wrapper)
      innerUnsub = () => {
        state.listeners.delete(wrapper)
        if (state.listeners.size === 0) this.stopSubscription(row.sandboxId)
      }
      if (unsubscribed) innerUnsub()
    })()
    return () => {
      unsubscribed = true
      innerUnsub?.()
    }
  }

  private ensureSubscription(sandboxId: string): void {
    let st = this.subs.get(sandboxId)
    if (!st) {
      st = { listeners: new Set(), controller: null, running: false, restartTimer: null }
      this.subs.set(sandboxId, st)
    }
    if (st.running) return
    st.running = true
    void this.runEventLoop(sandboxId).finally(() => {
      const s = this.subs.get(sandboxId)
      if (s) s.running = false
    })
  }

  private stopSubscription(sandboxId: string): void {
    const st = this.subs.get(sandboxId)
    if (!st) return
    if (st.controller) {
      try {
        st.controller.abort()
      } catch {
        /* ignore */
      }
    }
    if (st.restartTimer) {
      clearTimeout(st.restartTimer)
      st.restartTimer = null
    }
    this.subs.delete(sandboxId)
  }

  private async runEventLoop(sandboxId: string): Promise<void> {
    const st = this.subs.get(sandboxId)
    if (!st) return
    let client: OpencodeClient
    try {
      client = await this.getClient(sandboxId)
    } catch (err) {
      logger.warn({ err, sandboxId }, 'agent subscribe: client init failed')
      this.scheduleRestart(sandboxId)
      return
    }
    const controller = new AbortController()
    st.controller = controller
    try {
      // SDK returns an async iterable of SSE events.
      const stream = await client.event.subscribe({
        signal: controller.signal,
      })
      for await (const evt of stream.stream) {
        if (controller.signal.aborted) break
        await this.handleEvent(sandboxId, evt)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        logger.warn({ err, sandboxId }, 'agent event stream failed')
        this.invalidateClient(sandboxId)
        this.scheduleRestart(sandboxId)
      }
    } finally {
      st.controller = null
    }
  }

  private scheduleRestart(sandboxId: string): void {
    const st = this.subs.get(sandboxId)
    if (!st || st.listeners.size === 0) return
    if (st.restartTimer) return
    st.restartTimer = setTimeout(() => {
      st.restartTimer = null
      if (st.listeners.size > 0) this.ensureSubscription(sandboxId)
    }, 2_000)
    st.restartTimer.unref?.()
  }

  private async handleEvent(sandboxId: string, raw: unknown): Promise<void> {
    const ev = raw as { type?: string; properties?: Record<string, unknown> }
    const type = ev?.type
    const props = ev?.properties ?? {}
    if (!type) return

    // Extract the opencode session id where we can.
    let ocSessionId: string | undefined
    if (type === 'message.updated') {
      ocSessionId = (props.info as { sessionID?: string } | undefined)?.sessionID
    } else if (type === 'message.part.updated') {
      ocSessionId = (props.part as { sessionID?: string } | undefined)?.sessionID
    } else if (type === 'permission.updated') {
      ocSessionId = (props as { sessionID?: string }).sessionID
    } else if (type === 'permission.replied') {
      ocSessionId = (props as { sessionID?: string }).sessionID
    } else if (type === 'session.idle') {
      ocSessionId = (props as { sessionID?: string }).sessionID
    } else if (type === 'session.error') {
      ocSessionId = (props as { sessionID?: string }).sessionID
    } else {
      return
    }

    if (!ocSessionId) return

    // Track pending approvals so sessionStatus can surface them.
    if (type === 'permission.updated') {
      const p = props as unknown as {
        id: string
        sessionID: string
        title?: string
        pattern?: string | string[]
        metadata?: Record<string, unknown>
        time?: { created?: number }
      }
      let byPerm = this.pending.get(ocSessionId)
      if (!byPerm) {
        byPerm = new Map()
        this.pending.set(ocSessionId, byPerm)
      }
      byPerm.set(p.id, {
        id: p.id,
        sessionId: p.sessionID,
        title: p.title ?? 'Approval required',
        pattern: p.pattern,
        metadata: p.metadata ?? {},
        createdAt: p.time?.created ?? Date.now(),
      })
    } else if (type === 'permission.replied') {
      const p = props as { permissionID?: string }
      if (p.permissionID) this.pending.get(ocSessionId)?.delete(p.permissionID)
    }

    // Mirror message-updated to agent_transcripts so a later UI reload has
    // history even if the tab missed the event stream.
    if (type === 'message.updated') {
      await this.recordTranscript(ocSessionId, props)
    }

    const st = this.subs.get(sandboxId)
    if (!st) return
    const evt: TranscriptEvent = {
      type: type as TranscriptEvent['type'],
      sessionId: ocSessionId,
      payload: props,
    }
    for (const l of st.listeners) {
      try {
        l(evt)
      } catch (err) {
        logger.warn({ err }, 'transcript listener threw')
      }
    }
  }

  private async recordTranscript(
    opencodeSessionId: string,
    props: Record<string, unknown>,
  ): Promise<void> {
    const info = (props as { info?: { id?: string; role?: string } }).info
    if (!info?.id || !info.role) return
    const rows = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.opencodeSessionId, opencodeSessionId))
      .limit(1)
    const row = rows[0]
    if (!row) return
    const nextSeq = (this.seqCounters.get(row.id) ?? 0) + 1
    this.seqCounters.set(row.id, nextSeq)
    try {
      await db.insert(agentTranscripts).values({
        sessionId: row.id,
        seq: nextSeq,
        role: info.role,
        contentJson: props as Record<string, unknown>,
      })
      await db
        .update(agentSessions)
        .set({ lastActivityAt: new Date() })
        .where(eq(agentSessions.id, row.id))
    } catch (err) {
      logger.warn({ err, id: row.id }, 'transcript insert failed')
    }
  }

  private async requireSession(id: string) {
    const rows = await db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, id))
      .limit(1)
    const row = rows[0]
    if (!row) throw new AgentError('not_found', `agent session ${id} not found`)
    return row
  }
}

export const agentService = new AgentService()

// Note: password is referenced indirectly via `resolveEndpoint`.
void getOpenCodePassword
