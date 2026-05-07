import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { trpc } from '../../../trpc'
import { envTrpc } from '../../../env-trpc'
import { handleAgentUiOpenPaneEvent } from '../../../lib/agent-ui-open-pane'
import { openConfirmOverlay } from '../../../lib/overlay-layer-controller'
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
  title?: string | null
  workspaceId?: string | null
}

export function AgentSessionView({
  onOpenPane,
  onOpenPaneRefreshHint,
  onActiveSessionChange,
  onSessionListChange,
  workspaceId,
  activeSessionId,
  onSessionSelect,
  headerTrailing,
  footerTrailing,
  onOpenNewChat,
  headerLeading,
}: {
  onOpenPane?: (content: PaneContent, options?: OpenPaneOptions) => void
  onOpenPaneRefreshHint?: () => void
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
  headerTrailing?: ReactNode | ((newChat: { openNewChat: () => Promise<void>; setSessionId: (id: string) => void; workspaceId?: string } | null) => ReactNode)
  footerTrailing?: ReactNode
  onOpenNewChat?: () => Promise<string | null>
  headerLeading?: ReactNode
}) {
  const status = envTrpc.agent.agentStatus.useQuery(undefined, { refetchInterval: 5_000 })
  const sessionListInput = workspaceId ? { workspaceId } : undefined
  const sessions = envTrpc.agent.sessionList.useQuery(sessionListInput, { refetchInterval: 5_000 })
  const queryClient = useQueryClient()
  const maybeAutoNameWorkspace = trpc.workspace.maybeAutoNameFromPrompt.useMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.listTree') }),
  })
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
  const openNewChat = onOpenNewChat
    ? async () => {
        const id = await onOpenNewChat()
        if (!id) return
        await queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList', sessionListInput) })
        setSessionId(id)
      }
    : undefined

  const sessionsData = sessions.data as SessionSummary[] | undefined
  const activeSession = sessionsData?.find((session) => session.id === sessionId) ?? null
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

  const trailing = typeof headerTrailing === 'function'
    ? headerTrailing(openNewChat ? { openNewChat, setSessionId, workspaceId } : null)
    : headerTrailing

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none basis-8 items-stretch border-b border-neutral-800 bg-neutral-975">
        {headerLeading && <div className="flex items-center pl-3 pr-2">{headerLeading}</div>}
        <SessionTabs
          workspaceId={workspaceId}
          sessionId={sessionId}
          onSelect={(id) => setSessionId(id)}
        />
        {trailing && <div className="flex items-center px-2">{trailing}</div>}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {sessionId ? (
          <SessionPane
            key={sessionId}
            sessionId={sessionId}
            workspaceId={workspaceId}
            onWorkspaceAutoName={workspaceId ? (message) => maybeAutoNameWorkspace.mutateAsync({
              id: workspaceId,
              prompt: message,
              isFirstChat: retainedChatSessionIds.length === 1,
              chatHadExplicitTitle: Boolean(activeSession?.title),
            }) : undefined}
            onOpenPane={onOpenPane}
            onOpenPaneRefreshHint={onOpenPaneRefreshHint}
            footerTrailing={footerTrailing}
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
      className="flex items-center gap-1.5"
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
function AgentConnectivityMenu() {
  const restart = envTrpc.agent.restart.useMutation()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function onClick() {
    const confirmed = await openConfirmOverlay({
      title: 'Restart agent?',
      message: 'Active runs will be interrupted.',
      confirmLabel: 'Restart',
      destructive: true,
    })
    if (!confirmed) return
    setErr(null)
    try {
      await restart.mutateAsync()
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.agentStatus') }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList') }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.listModels') }),
      ])
      setOpen(false)
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  async function refreshStatus() {
    setErr(null)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.agentStatus') }),
      queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList') }),
      queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.listModels') }),
    ])
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={err ?? 'OpenCode connected'}
        aria-label="OpenCode connection status"
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          'flex h-7 items-center gap-1.5 rounded border px-2 text-[11px] shadow-sm ' +
          (err
            ? 'border-red-800 bg-red-950/30 text-red-300 hover:bg-red-950/50'
            : open
              ? 'border-emerald-800/80 bg-emerald-950/30 text-emerald-200'
              : 'border-neutral-800 bg-neutral-900/60 text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100')
        }
      >
        <span
          className={
            'h-2 w-2 rounded-full ' +
            (err ? 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.8)]' : 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]')
          }
          aria-hidden="true"
        />
        <span className="hidden sm:inline">OpenCode</span>
        <span aria-hidden className="text-neutral-500">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 bottom-full z-30 mb-1 w-64 rounded border border-neutral-800 bg-neutral-950 shadow-lg" role="menu">
          <div className="border-b border-neutral-800 px-3 py-2">
            <div className="flex items-center gap-2 text-xs text-neutral-100">
              <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden="true" />
              <span>OpenCode connected</span>
            </div>
            <p className="mt-1 text-[11px] text-neutral-500">Agent service is reachable in this environment.</p>
          </div>
          <button
            type="button"
            onClick={() => void onClick()}
            disabled={restart.isPending}
            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs text-neutral-200 hover:bg-neutral-900 disabled:opacity-60"
            role="menuitem"
          >
            <span>{restart.isPending ? 'Restarting…' : 'Restart agent'}</span>
            <span className="text-[10px] text-neutral-500">Interrupts runs</span>
          </button>
          <button
            type="button"
            onClick={() => void refreshStatus()}
            className="flex w-full items-center justify-between gap-3 border-t border-neutral-800 px-3 py-2 text-left text-xs text-neutral-300 hover:bg-neutral-900"
            role="menuitem"
          >
            <span>Refresh status</span>
            <span className="text-[10px] text-neutral-500">Models + sessions</span>
          </button>
          <Link
            to="/settings"
            onClick={() => setOpen(false)}
            className="block border-t border-neutral-800 px-3 py-2 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            role="menuitem"
          >
            Provider settings
          </Link>
          {err && <div className="border-t border-red-900 bg-red-950/50 px-3 py-1.5 text-[11px] text-red-300">{err}</div>}
        </div>
      )}
    </div>
  )
}

function SessionPane({
  sessionId,
  workspaceId,
  onWorkspaceAutoName,
  onOpenPane,
  onOpenPaneRefreshHint,
  footerTrailing,
}: {
  sessionId: string
  workspaceId?: string
  onWorkspaceAutoName?: (message: string) => Promise<unknown>
  onOpenPane?: (content: PaneContent, options?: OpenPaneOptions) => void
  onOpenPaneRefreshHint?: () => void
  footerTrailing?: ReactNode
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
        handleAgentUiOpenPaneEvent(
          evt as { type: string; content: PaneContent; title?: string; activate: boolean },
          onOpenPane,
          onOpenPaneRefreshHint,
        )
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
      if (p.type === 'patch') continue
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
          <div className="shrink-0 space-y-2 border-t border-neutral-800 bg-neutral-975 p-3">
            {activeQuestions.map((q) => (
              <QuestionBanner key={q.id} req={q} sessionId={sessionId} />
            ))}
          </div>
        )}
        <TodosPanel todos={state.todos} />
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
          onWorkspaceAutoName={async (message) => {
            if (!workspaceId) return
            await onWorkspaceAutoName?.(message)
          }}
        />
        <div className="mb-2 flex shrink-0 items-center gap-2 bg-neutral-975 px-2 py-1">
          <ModelPicker sessionId={sessionId} />
          <ReasoningEffortPicker sessionId={sessionId} />
          <div className="ml-auto flex items-center gap-1.5">
            {statusData?.contextUsage && (
              <ContextUsageBar used={statusData.contextUsage.used} limit={statusData.contextUsage.limit} />
            )}
            {footerTrailing}
            <AgentConnectivityMenu />
          </div>
        </div>
      </div>
    </div>
  )
}
