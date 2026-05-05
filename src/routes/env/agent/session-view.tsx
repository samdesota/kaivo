import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { envTrpc } from '../../../env-trpc'
import { handleAgentUiOpenPaneEvent } from '../../../lib/agent-ui-open-pane'
import { trpcQueryKey } from '../../../lib/trpc-plain'
import { extractTrpcMessage } from '../../../lib/utils'
import type { PaneContent } from '../shell/tab-state'
import { Composer } from './composer'
import { QuestionBanner } from './parts/question-banner'
import { TodosPanel } from './todos-panel'
import { flattenParts, type TranscriptState } from './transcript-store'
import { PartRenderer } from './parts'
import { OpenStateProvider } from './parts/open-state'
import { SessionTabs } from './session-tabs'
import { EmptySessionState } from './empty-session-state'
import { ModelPicker, ReasoningEffortPicker } from './model-picker'
import { selectActiveWorkspaceSession } from './workspace-session-state'
import { BottomAnchoredLazyList } from './bottom-anchored-lazy-list'
import { useChatSession, useChatStateStore, useRetainChatSessions } from './chat-state'
import { chatDebug } from './chat-debug'

interface OpenPaneOptions {
  title?: string
  activate?: boolean
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

export function AgentSessionView({
  onOpenPane,
  onActiveSessionChange,
  onSessionListChange,
  workspaceId,
  activeSessionId,
  onSessionSelect,
  headerTrailing,
  onOpenNewChat,
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
  headerTrailing?: ReactNode
  onOpenNewChat?: () => Promise<string | null>
}) {
  const status = envTrpc.agent.agentStatus.useQuery(undefined, { refetchInterval: 5_000 })
  const sessionListInput = workspaceId ? { workspaceId } : undefined
  const sessions = envTrpc.agent.sessionList.useQuery(sessionListInput, { refetchInterval: 5_000 })
  const queryClient = useQueryClient()
  const [internalSessionId, setInternalSessionId] = useState<string | null>(null)
  const sessionId = activeSessionId !== undefined ? activeSessionId : internalSessionId
  const setSessionId = useCallback((id: string | null) => {
    if (onSessionSelect) onSessionSelect(id)
    else setInternalSessionId(id)
  }, [onSessionSelect])
  useEffect(() => {
    onActiveSessionChange?.(sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])
  const start = envTrpc.agent.startAgent.useMutation()
  const [startError, setStartError] = useState<string | null>(null)

  const sessionsData = sessions.data as SessionSummary[] | undefined
  const retainedChatSessionIds = useMemo(
    () => (sessionsData ?? []).filter((s) => s.status !== 'archived').map((s) => s.id),
    [sessionsData],
  )
  useRetainChatSessions(retainedChatSessionIds)

  useEffect(() => {
    if (sessionsData) onSessionListChange?.(sessionsData.length)
  }, [sessionsData, onSessionListChange])

  useEffect(() => {
    if (!sessionsData) return
    const next = selectActiveWorkspaceSession(sessionsData, sessionId)
    if (next !== sessionId) setSessionId(next)
  }, [sessionId, sessionsData, setSessionId])

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
          onOpenNewChat={
            onOpenNewChat
              ? async () => {
                  const id = await onOpenNewChat()
                  if (!id) return
                  await queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList', sessionListInput) })
                  setSessionId(id)
                }
              : undefined
          }
        />
        {headerTrailing}
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
  const queryClient = useQueryClient()
  const [err, setErr] = useState<string | null>(null)

  async function onClick() {
    if (!confirm('Restart agent? Active runs will be interrupted.')) return
    setErr(null)
    try {
      await restart.mutateAsync()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.agentStatus') }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList') }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.listModels') }),
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
  const chat = useChatSession(sessionId)
  const chatStore = useChatStateStore()
  const { state, loading, error, reconnecting, running, status } = chat

  useEffect(() => {
    chatDebug('session-pane:snapshot', {
      sessionId,
      loading,
      hasError: Boolean(error),
      reconnecting,
      running,
      messageCount: state.messageOrder.length,
      partCount: state.parts.size,
      permissions: state.permissions.size,
      questions: state.questions.size,
    })
  }, [sessionId, loading, error, reconnecting, running, state])

  useEffect(() => chatStore.retainSession(sessionId), [chatStore, sessionId])

  envTrpc.agentUi.events.useSubscription(
    { sessionId },
    {
      onData(evt) {
        handleAgentUiOpenPaneEvent(evt as { type: string; content: PaneContent; title?: string; activate: boolean }, onOpenPane)
      },
    },
  )

  const statusData = status
  const pendingFromStatus = statusData?.pendingApprovals ?? []
  const pendingCount = state.permissions.size > 0 ? state.permissions.size : pendingFromStatus.length

  const activeQuestions = Array.from(state.questions.values())

  const parts = useMemo(() => flattenParts(state), [state])
  const renderables = useMemo(() => {
    let taskIdx = 0
    const out: Array<{ part: typeof parts[number]; role: string; childTranscript?: TranscriptState }> = []
    let skippedSynthetic = 0
    let skippedSystem = 0
    for (const p of parts) {
      let childTranscript: TranscriptState | undefined
      if (p.type === 'tool' && (p as { tool?: string }).tool === 'task') {
        const childOcId = state.childOrder[taskIdx]
        if (childOcId) childTranscript = state.childTranscripts.get(childOcId)
        taskIdx++
      }
      if (p.type === 'step-start' || p.type === 'snapshot' || p.type === 'step-finish') {
        skippedSystem++
        continue
      }
      if ((p as { synthetic?: boolean }).synthetic) {
        skippedSynthetic++
        continue
      }
      const role = state.messages.get(p.messageID)?.role ?? 'assistant'
      out.push({ part: p, role, childTranscript })
    }
    chatDebug('session-pane:renderables', {
      sessionId,
      loading,
      inputParts: parts.length,
      renderables: out.length,
      skippedSystem,
      skippedSynthetic,
      optimisticParts: parts.filter((p) => (p as { optimistic?: boolean }).optimistic).length,
    })
    return out
  }, [loading, parts, sessionId, state.messages, state.childOrder, state.childTranscripts])

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-end gap-2 border-b border-neutral-800/60 bg-neutral-950 px-3 py-1">
          {statusData?.contextUsage && (
            <ContextUsageBar used={statusData.contextUsage.used} limit={statusData.contextUsage.limit} />
          )}
          <RestartAgentButton />
          <ModelPicker sessionId={sessionId} />
          <ReasoningEffortPicker sessionId={sessionId} />
        </div>
        {reconnecting && (
          <div className="border-b border-amber-500/40 bg-amber-500/5 px-3 py-1 text-[11px] text-amber-200">
            Reconnecting…
          </div>
        )}
        <OpenStateProvider>
          <div className="flex min-h-0 flex-1">
            {loading ? (
              <div className="flex flex-1 items-center justify-center text-xs text-neutral-500">Loading…</div>
            ) : error ? (
              <div className="flex-1 p-4 text-xs text-red-400">
                Failed to load transcript: {extractTrpcMessage(error)}
              </div>
            ) : renderables.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-xs text-neutral-500">
                No messages yet.
              </div>
            ) : (
              <BottomAnchoredLazyList
                resetKey={sessionId}
                items={renderables}
                itemKey={({ part }) => part.id}
                renderItem={({ part, role, childTranscript }, index, isLast) => {
                  const prev = index > 0 ? renderables[index - 1] : null
                  const isTool = part.type === 'tool'
                  const prevIsTool = prev?.part.type === 'tool'
                  const padTop = index === 0 ? 12 : isTool && prevIsTool ? 6 : 8
                  const padBottom = isLast ? 12 : 0
                  return (
                    <div
                      className="px-4"
                      style={{ paddingTop: padTop, paddingBottom: padBottom }}
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
                }}
              />
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
          onSendStart={(message) => {
            chatDebug('session-pane:onSendStart', { sessionId, messageLength: message.length })
            return chatStore.addOptimisticUserMessage(sessionId, message)
          }}
          onSendFailed={(optimisticId) => {
            chatDebug('session-pane:onSendFailed', { sessionId, optimisticId })
            if (optimisticId) chatStore.removeOptimisticUserMessage(sessionId, optimisticId)
          }}
          onSent={() => {
            chatDebug('session-pane:onSent', { sessionId })
            chatStore.markSent(sessionId)
          }}
        />
      </div>
      <TodosPanel todos={state.todos} />
    </div>
  )
}
