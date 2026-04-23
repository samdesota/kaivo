import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { trpc } from '../../../trpc'
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
import { SessionTabs } from './session-tabs'
import { EmptySessionState } from './empty-session-state'
import { ModelPicker } from './model-picker'

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

export function AgentSessionView({
  sandboxId,
  onOpenShell,
}: {
  sandboxId: string
  onOpenShell?: (content: PaneContent) => void
}) {
  const status = trpc.agent.agentStatus.useQuery({ sandboxId }, { refetchInterval: 5_000 })
  const sessions = trpc.agent.sessionList.useQuery({ sandboxId }, { refetchInterval: 5_000 })
  const [sessionId, setSessionId] = useState<string | null>(null)
  const start = trpc.agent.startAgent.useMutation()
  const [startError, setStartError] = useState<string | null>(null)

  // Default to the most recent ACTIVE session when sessionList loads. If the
  // currently-selected session gets archived, jump to another active one.
  useEffect(() => {
    if (!sessions.data) return
    const activeList = sessions.data.filter((s) => s.status !== 'archived')
    const stillOpen = sessionId && activeList.some((s) => s.id === sessionId)
    if (!stillOpen) {
      const first = activeList[0]?.id ?? null
      if (first !== sessionId) setSessionId(first)
    }
  }, [sessionId, sessions.data])

  if (status.isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-500">Checking agent…</div>
  }

  if (!status.data?.hasProvider) {
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

  if (!status.data.ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-sm text-neutral-300">Agent not running.</div>
        <button
          onClick={async () => {
            setStartError(null)
            try {
              await start.mutateAsync({ sandboxId })
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
          sandboxId={sandboxId}
          sessionId={sessionId}
          onSelect={(id) => setSessionId(id)}
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {sessionId ? (
          <SessionPane
            key={sessionId}
            sandboxId={sandboxId}
            sessionId={sessionId}
            onOpenShell={onOpenShell}
          />
        ) : (
          <EmptySessionState sandboxId={sandboxId} onCreated={(id) => setSessionId(id)} />
        )}
      </div>
    </div>
  )
}

function SessionPane({
  sandboxId,
  sessionId,
  onOpenShell,
}: {
  sandboxId: string
  sessionId: string
  onOpenShell?: (content: PaneContent) => void
}) {
  const [state, dispatch] = useReducer(reducer, undefined as unknown as TranscriptState, emptyTranscript)
  const [reconnecting, setReconnecting] = useState(false)

  const messages = trpc.agent.sessionMessages.useQuery(
    { sessionId },
    {
      staleTime: 0,
      refetchOnWindowFocus: false,
    },
  )

  const childMsgs = trpc.agent.childTranscripts.useQuery(
    { sessionId },
    { staleTime: 0, refetchOnWindowFocus: false },
  )

  // Hydrate from cold load exactly once per session.
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

  // Hydrate child transcripts when they arrive (separately from the parent's
  // cold load — same-session, different query). Safe to dispatch repeatedly:
  // hydrateChildren upserts so it converges to the latest snapshot.
  useEffect(() => {
    if (!childMsgs.data) return
    if (hydrated.current !== sessionId) return
    dispatch({ type: 'hydrate-children', children: childMsgs.data })
  }, [sessionId, childMsgs.data])

  // Live-merge events. `onError` flips the reconnect banner; tRPC's ws client
  // auto-reconnects under the hood, so the banner clears on the next `onData`.
  // Mirror server-derived "running" so the UI shows loading immediately on
  // hydrate. Live events flip this off on idle/error and on the first send
  // we set it on optimistically (the next status poll confirms).
  const [running, setRunning] = useState(false)

  trpc.agent.transcript.useSubscription(
    { sessionId },
    {
      onData(evt) {
        setReconnecting(false)
        if (evt.type === 'session.idle' || evt.type === 'session.error') {
          if ((evt.payload as { sessionID?: string })?.sessionID && !evt.parentSessionId) {
            setRunning(false)
          }
        } else if (evt.type === 'message.part.updated' && !evt.parentSessionId) {
          setRunning(true)
        }
        dispatch({
          type: 'event',
          evt: evt as {
            type: string
            parentSessionId?: string
            payload: Record<string, unknown>
          },
        })
      },
      onError() {
        setReconnecting(true)
      },
    },
  )

  const status = trpc.agent.sessionStatus.useQuery(
    { sessionId },
    { refetchInterval: 3_000 },
  )
  const pendingFromStatus = status.data?.pendingApprovals ?? []
  const questionsFromStatus = status.data?.pendingQuestions ?? []
  // Reconcile with server's authoritative running state on each poll. Avoids
  // a stale "running" if we miss the idle event due to a brief disconnect.
  useEffect(() => {
    if (status.data) setRunning(status.data.running)
  }, [status.data])
  // Merge with in-memory permission events so we catch requests that arrive
  // between sessionStatus poll ticks.
  const pendingCount = state.permissions.size > 0 ? state.permissions.size : pendingFromStatus.length

  // Hydrate questions from sessionStatus into the transcript reducer so a
  // page reload (which misses the original question.asked event) still
  // surfaces the pending question. Handles diffs both ways.
  useEffect(() => {
    if (!status.data) return
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
  }, [status.data])

  const activeQuestions = Array.from(state.questions.values())

  // Hydrate todos from sessionStatus on first load. Live updates flow via
  // todo.updated events; the reducer always replaces the whole list.
  useEffect(() => {
    if (!status.data) return
    if (state.todos.length === 0 && status.data.todos.length > 0) {
      dispatch({
        type: 'event',
        evt: { type: 'todo.updated', payload: { todos: status.data.todos } },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data])

  const parts = useMemo(() => flattenParts(state), [state])
  const renderables = useMemo(() => {
    let taskIdx = 0
    return parts.map((p) => {
      const role = state.messages.get(p.messageID)?.role ?? 'assistant'
      let childTranscript: TranscriptState | undefined
      if (p.type === 'tool' && (p as { tool?: string }).tool === 'task') {
        const childOcId = state.childOrder[taskIdx]
        if (childOcId) childTranscript = state.childTranscripts.get(childOcId)
        taskIdx++
      }
      return { part: p, role, childTranscript }
    })
  }, [parts, state.messages, state.childOrder, state.childTranscripts])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rowVirtualizer = useVirtualizer({
    count: renderables.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    overscan: 8,
    getItemKey: (i) => renderables[i]!.part.id,
  })

  // Auto-stick to bottom while the user hasn't scrolled away. Tracks intent
  // separately from row count so streaming text (which mutates the *same*
  // part rather than appending one) still keeps the view pinned.
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
      <div className="flex shrink-0 items-center justify-end border-b border-neutral-800/60 bg-neutral-950 px-3 py-1">
        <ModelPicker sandboxId={sandboxId} sessionId={sessionId} />
      </div>
      {reconnecting && (
        <div className="border-b border-amber-500/40 bg-amber-500/5 px-3 py-1 text-[11px] text-amber-200">
          Reconnecting…
        </div>
      )}
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
              // Tighter spacing for tool calls; tool-adjacent-to-tool gets
              // the least so a chain of tool calls reads as one block.
              const padTop =
                v.index === 0 ? 12 : isTool && prevIsTool ? 1 : isTool ? 2 : prevIsTool ? 2 : 6
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
                    sandboxId={sandboxId}
                    onOpenShell={onOpenShell}
                    childTranscript={childTranscript}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
      {activeQuestions.length > 0 && (
        <div className="shrink-0 space-y-2 border-t border-neutral-800 bg-neutral-950 p-3">
          {activeQuestions.map((q) => (
            <QuestionBanner key={q.id} req={q} sessionId={sessionId} />
          ))}
        </div>
      )}
      <Composer
        sandboxId={sandboxId}
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
