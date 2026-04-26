import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { envTrpc } from '../../../env-trpc'
import { handleAgentUiOpenPaneEvent } from '../../../lib/agent-ui-open-pane'
import { extractTrpcMessage } from '../../../lib/utils'
import type { PaneContent } from '../shell/tab-state'
import { Composer } from './composer'
import { QuestionBanner } from './parts/question-banner'
import { TodosPanel } from './todos-panel'
import {
  applyEvent,
  emptyTranscript,
  flattenParts,
  hydrateChildren,
  hydrateFromMessages,
  type TranscriptState,
} from './transcript-store'
import { PartRenderer } from './parts'
import { OpenStateProvider } from './parts/open-state'
import { SessionTabs } from './session-tabs'
import { EmptySessionState } from './empty-session-state'
import { ModelPicker } from './model-picker'
import { selectActiveWorkspaceSession } from './workspace-session-state'

type Action =
  | { type: 'reset' }
  | {
      type: 'hydrate'
      msgs: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
    }
  | {
      type: 'hydrate-children'
      children: Array<{ sessionID: string; messages: Array<{ info: unknown; parts: unknown[] }> }>
    }
  | {
      type: 'event'
      evt: { type: string; parentSessionId?: string; payload: Record<string, unknown> }
    }

interface OpenPaneOptions {
  title?: string
  activate?: boolean
}

function reducer(state: TranscriptState, action: Action): TranscriptState {
  switch (action.type) {
    case 'reset':
      return emptyTranscript()
    case 'hydrate':
      return hydrateFromMessages(state, action.msgs as Array<{ info: unknown; parts: unknown[] }>)
    case 'hydrate-children':
      return hydrateChildren(state, action.children)
    case 'event':
      return applyEvent(state, action.evt)
    default:
      return state
  }
}

interface AgentStatus {
  hasProvider: boolean
  ready: boolean
}

interface SessionSummary {
  id: string
  status: string
  workspaceId?: string | null
}

interface SessionStatus {
  running: boolean
  pendingApprovals: Array<{
    id: string
    sessionId: string
    callID?: string
    title: string
    pattern?: string | string[]
    metadata: Record<string, unknown>
    createdAt: number
  }>
  pendingQuestions: Array<{
    id: string
    sessionId: string
    questions: unknown[]
    tool?: unknown
  }>
  todos: Array<{ id: string; content: string; status: string; priority: string }>
  contextUsage: { used: number; limit: number } | null
}

export function AgentSessionView({
  onOpenPane,
  onActiveSessionChange,
  onSessionListChange,
  workspaceId,
  activeSessionId,
  onSessionSelect,
}: {
  onOpenPane?: (content: PaneContent, options?: OpenPaneOptions) => void
  /**
   * Fires whenever the focused session changes. Lets EnvTabShell forward
   * the active session id (and thus its working dir) to the command
   * palette so new shells default to the session's cwd.
   */
  onActiveSessionChange?: (sessionId: string | null) => void
  onSessionListChange?: (count: number) => void
  workspaceId?: string
  activeSessionId?: string | null
  onSessionSelect?: (sessionId: string | null) => void
}) {
  const status = envTrpc.agent.agentStatus.useQuery(undefined, { refetchInterval: 5_000 })
  const sessionListInput = workspaceId ? { workspaceId } : undefined
  const sessions = envTrpc.agent.sessionList.useQuery(sessionListInput, { refetchInterval: 5_000 })
  const [internalSessionId, setInternalSessionId] = useState<string | null>(null)
  const sessionId = activeSessionId !== undefined ? activeSessionId : internalSessionId
  const setSessionId = (id: string | null) => {
    if (onSessionSelect) onSessionSelect(id)
    else setInternalSessionId(id)
  }
  useEffect(() => {
    onActiveSessionChange?.(sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
  const start = envTrpc.agent.startAgent.useMutation()
  const [startError, setStartError] = useState<string | null>(null)

  const sessionsData = sessions.data as SessionSummary[] | undefined

  useEffect(() => {
    if (sessionsData) onSessionListChange?.(sessionsData.length)
  }, [sessionsData, onSessionListChange])

  useEffect(() => {
    if (!sessionsData) return
    const next = selectActiveWorkspaceSession(sessionsData, sessionId)
    if (next !== sessionId) setSessionId(next)
  }, [sessionId, sessionsData])

  if (status.isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-500">Checking agent…</div>
  }

  const statusData = status.data as AgentStatus | undefined

  if (!statusData?.hasProvider) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-sm text-neutral-300">No AI provider configured.</div>
        <Link
          to="/settings"
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm hover:bg-neutral-800"
        >
          Open Settings →
        </Link>
      </div>
    )
  }

  if (!statusData.ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-sm text-neutral-300">Agent not running.</div>
        <button
          onClick={async () => {
            setStartError(null)
            try {
              await start.mutateAsync()
              await status.refetch()
            } catch (err) {
              setStartError(extractTrpcMessage(err))
            }
          }}
          disabled={start.isPending}
          className="rounded-md bg-brand-500 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:opacity-60"
        >
          {start.isPending ? 'Starting…' : 'Start agent'}
        </button>
        {startError && <p className="max-w-sm text-xs text-red-400">{startError}</p>}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-3 py-1.5">
        <SessionTabs
          workspaceId={workspaceId}
          sessionId={sessionId}
          onSelect={(id) => setSessionId(id)}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {sessionId ? (
          <SessionPane
            key={sessionId}
            sessionId={sessionId}
            onOpenPane={onOpenPane}
          />
        ) : (
          <EmptySessionState workspaceId={workspaceId} onCreated={(id) => setSessionId(id)} />
        )}
      </div>
    </div>
  )
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

function ContextUsageBar({ used, limit }: { used: number; limit: number }) {
  const pct = Math.min(100, (used / limit) * 100)
  const color =
    pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-brand-500'
  return (
    <div
      className="flex items-center gap-1.5 mr-auto"
      title={`${formatTokenCount(used)} / ${formatTokenCount(limit)} tokens`}
    >
      <div className="h-1.5 w-16 rounded-full bg-neutral-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${Math.max(pct, 1)}%` }}
        />
      </div>
      <span className="text-[10px] text-neutral-500">
        {pct.toFixed(0)}%
      </span>
    </div>
  )
}

/**
 * Bounces opencode in the env (env-side `agent.restart`). Useful after
 * provider keys change in /settings — opencode reloads them on boot.
 */
function RestartAgentButton() {
  const restart = envTrpc.agent.restart.useMutation()
  const utils = envTrpc.useUtils()
  const [err, setErr] = useState<string | null>(null)

  async function onClick() {
    if (!confirm('Restart agent? Active runs will be interrupted.')) return
    setErr(null)
    try {
      await restart.mutateAsync()
      await Promise.all([
        utils.agent.agentStatus.invalidate(),
        utils.agent.sessionList.invalidate(),
        utils.agent.listModels.invalidate(),
      ])
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  return (
    <button
      onClick={() => void onClick()}
      disabled={restart.isPending}
      title={err ?? 'Restart the agent (e.g. after changing provider keys)'}
      className={
        'rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-900 disabled:opacity-50 ' +
        (err ? 'border-red-700 text-red-300' : '')
      }
    >
      {restart.isPending ? 'Restarting…' : 'Restart agent'}
    </button>
  )
}

function SessionPane({
  sessionId,
  onOpenPane,
}: {
  sessionId: string
  onOpenPane?: (content: PaneContent, options?: OpenPaneOptions) => void
}) {
  const [state, dispatch] = useReducer(reducer, undefined as unknown as TranscriptState, emptyTranscript)
  const [reconnecting, setReconnecting] = useState(false)

  const messages = envTrpc.agent.sessionMessages.useQuery(
    { sessionId },
    { staleTime: 0, refetchOnWindowFocus: false },
  )

  const childMsgs = envTrpc.agent.childTranscripts.useQuery(
    { sessionId },
    { staleTime: 0, refetchOnWindowFocus: false },
  )

  const hydrated = useRef<string | null>(null)
  useEffect(() => {
    if (!messages.data) return
    if (hydrated.current === sessionId) return
    hydrated.current = sessionId
    dispatch({ type: 'reset' })
    dispatch({
      type: 'hydrate',
      msgs: messages.data as Array<{
        info: Record<string, unknown>
        parts: Array<Record<string, unknown>>
      }>,
    })
  }, [sessionId, messages.data])

  useEffect(() => {
    if (!childMsgs.data) return
    if (hydrated.current !== sessionId) return
    dispatch({
      type: 'hydrate-children',
      children: childMsgs.data as Array<{
        sessionID: string
        messages: Array<{ info: unknown; parts: unknown[] }>
      }>,
    })
  }, [sessionId, childMsgs.data])

  const [running, setRunning] = useState(false)

  envTrpc.agent.transcript.useSubscription(
    { sessionId },
    {
      onData(evt: unknown) {
        setReconnecting(false)
        const e = evt as {
          type: string
          parentSessionId?: string
          payload: Record<string, unknown>
        }
        if (e.type === 'session.idle' || e.type === 'session.error') {
          if ((e.payload as { sessionID?: string })?.sessionID && !e.parentSessionId) {
            setRunning(false)
          }
        } else if (e.type === 'message.part.updated' && !e.parentSessionId) {
          setRunning(true)
        }
        dispatch({ type: 'event', evt: e })
      },
      onError() {
        setReconnecting(true)
      },
    },
  )

  envTrpc.agentUi.events.useSubscription(
    { sessionId },
    {
      onData(evt) {
        handleAgentUiOpenPaneEvent(evt as { type: string; content: PaneContent; title?: string; activate: boolean }, onOpenPane)
      },
    },
  )

  const sessionStatus = envTrpc.agent.sessionStatus.useQuery(
    { sessionId },
    { refetchInterval: 3_000 },
  )
  const statusData = sessionStatus.data as SessionStatus | undefined
  const pendingFromStatus = statusData?.pendingApprovals ?? []
  const questionsFromStatus = statusData?.pendingQuestions ?? []
  useEffect(() => {
    if (statusData) setRunning(statusData.running)
  }, [statusData])
  const pendingCount = state.permissions.size > 0 ? state.permissions.size : pendingFromStatus.length

  useEffect(() => {
    if (!statusData) return
    const live = state.questions
    for (const q of questionsFromStatus) {
      if (!live.has(q.id)) {
        dispatch({
          type: 'event',
          evt: {
            type: 'question.asked',
            payload: {
              id: q.id,
              sessionID: q.sessionId,
              questions: q.questions,
              tool: q.tool,
            },
          },
        })
      }
    }
    for (const id of live.keys()) {
      if (!questionsFromStatus.some((q) => q.id === id)) {
        dispatch({
          type: 'event',
          evt: {
            type: 'question.replied',
            payload: { requestID: id },
          },
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusData])

  // Mirror the question reconciliation for permissions. The transcript
  // subscription is live-only, so a page reload (or a missed event
  // window) leaves `state.permissions` empty while the env-server still
  // has pending approvals — banner doesn't render but the composer is
  // gated on the count, leaving the user unable to type.
  useEffect(() => {
    if (!statusData) return
    const live = state.permissions
    for (const p of pendingFromStatus) {
      if (!live.has(p.id)) {
        dispatch({
          type: 'event',
          evt: {
            type: 'permission.updated',
            payload: {
              id: p.id,
              sessionID: p.sessionId,
              callID: p.callID,
              title: p.title,
              pattern: p.pattern,
              metadata: p.metadata,
              time: { created: p.createdAt },
            },
          },
        })
      }
    }
    for (const id of live.keys()) {
      if (!pendingFromStatus.some((p) => p.id === id)) {
        dispatch({
          type: 'event',
          evt: {
            type: 'permission.replied',
            payload: { permissionID: id },
          },
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusData])

  const activeQuestions = Array.from(state.questions.values())

  useEffect(() => {
    if (!statusData) return
    if (state.todos.length === 0 && statusData.todos.length > 0) {
      dispatch({
        type: 'event',
        evt: { type: 'todo.updated', payload: { todos: statusData.todos } },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusData])

  const parts = useMemo(() => flattenParts(state), [state])
  const renderables = useMemo(() => {
    let taskIdx = 0
    const out: Array<{ part: typeof parts[number]; role: string; childTranscript?: TranscriptState }> = []
    for (const p of parts) {
      let childTranscript: TranscriptState | undefined
      if (p.type === 'tool' && (p as { tool?: string }).tool === 'task') {
        const childOcId = state.childOrder[taskIdx]
        if (childOcId) childTranscript = state.childTranscripts.get(childOcId)
        taskIdx++
      }
      if (p.type === 'step-start' || p.type === 'snapshot' || p.type === 'step-finish') continue
      if ((p as { synthetic?: boolean }).synthetic) continue
      const role = state.messages.get(p.messageID)?.role ?? 'assistant'
      out.push({ part: p, role, childTranscript })
    }
    return out
  }, [parts, state.messages, state.childOrder, state.childTranscripts])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rowVirtualizer = useVirtualizer({
    count: renderables.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    overscan: 8,
    getItemKey: (i) => renderables[i]!.part.id,
  })

  const stickToBottom = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    function onScroll() {
      const atBottom = el!.scrollHeight - el!.scrollTop - el!.clientHeight < 80
      stickToBottom.current = atBottom
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const totalSize = rowVirtualizer.getTotalSize()
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [totalSize, renderables.length])

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-end gap-2 border-b border-neutral-800/60 bg-neutral-950 px-3 py-1">
          {statusData?.contextUsage && (
            <ContextUsageBar used={statusData.contextUsage.used} limit={statusData.contextUsage.limit} />
          )}
          <RestartAgentButton />
          <ModelPicker sessionId={sessionId} />
        </div>
        {reconnecting && (
          <div className="border-b border-amber-500/40 bg-amber-500/5 px-3 py-1 text-[11px] text-amber-200">
            Reconnecting…
          </div>
        )}
        <OpenStateProvider>
          <div ref={scrollRef} className="flex-1 overflow-auto">
            {messages.isLoading ? (
              <div className="flex h-full items-center justify-center text-xs text-neutral-500">Loading…</div>
            ) : messages.error ? (
              <div className="p-4 text-xs text-red-400">
                Failed to load transcript: {extractTrpcMessage(messages.error)}
              </div>
            ) : renderables.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-neutral-500">
                No messages yet.
              </div>
            ) : (
              <div
                className="relative w-full"
                style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
              >
                {rowVirtualizer.getVirtualItems().map((v) => {
                  const { part, role, childTranscript } = renderables[v.index]!
                  const prev = v.index > 0 ? renderables[v.index - 1] : null
                  const isTool = part.type === 'tool'
                  const prevIsTool = prev?.part.type === 'tool'
                  const isLast = v.index === renderables.length - 1
                  const padTop = v.index === 0 ? 12 : isTool && prevIsTool ? 6 : 8
                  const padBottom = isLast ? 12 : 0
                  return (
                    <div
                      key={v.key}
                      ref={rowVirtualizer.measureElement}
                      data-index={v.index}
                      className="absolute left-0 right-0 px-4"
                      style={{
                        transform: `translateY(${v.start}px)`,
                        paddingTop: padTop,
                        paddingBottom: padBottom,
                      }}
                    >
                      <PartRenderer
                        part={part}
                        state={state}
                        role={role}
                        sessionId={sessionId}
                        onOpenShell={onOpenPane}
                        childTranscript={childTranscript}
                      />
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </OpenStateProvider>
        {activeQuestions.length > 0 && (
          <div className="shrink-0 space-y-2 border-t border-neutral-800 bg-neutral-950 p-3">
            {activeQuestions.map((q) => (
              <QuestionBanner key={q.id} req={q} sessionId={sessionId} />
            ))}
          </div>
        )}
        <Composer
          sessionId={sessionId}
          pendingApprovalReason={
            pendingCount > 0
              ? `Waiting on ${pendingCount} permission approval${pendingCount === 1 ? '' : 's'}.`
              : activeQuestions.length > 0
                ? `Agent is asking ${activeQuestions.length} question${activeQuestions.length === 1 ? '' : 's'}.`
                : null
          }
          running={running}
          onSent={() => setRunning(true)}
        />
      </div>
      <TodosPanel todos={state.todos} />
    </div>
  )
}
