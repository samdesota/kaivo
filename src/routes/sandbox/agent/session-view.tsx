import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { trpc } from '../../../trpc'
import { extractTrpcMessage } from '../../../lib/utils'
import type { PaneContent } from '../shell/tab-state'
import {
  applyEvent,
  emptyTranscript,
  flattenParts,
  hydrateFromMessages,
  type TranscriptState,
} from './transcript-store'
import { PartRenderer } from './parts'
import { SessionSwitcher } from './session-switcher'

type Action =
  | { type: 'reset' }
  | {
      type: 'hydrate'
      msgs: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
    }
  | { type: 'event'; evt: { type: string; payload: Record<string, unknown> } }

function reducer(state: TranscriptState, action: Action): TranscriptState {
  switch (action.type) {
    case 'reset':
      return emptyTranscript()
    case 'hydrate':
      return hydrateFromMessages(state, action.msgs as Array<{ info: unknown; parts: unknown[] }>)
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

  // Default to the most recent session when sessionList loads.
  useEffect(() => {
    if (sessionId) return
    const first = sessions.data?.[0]
    if (first) setSessionId(first.id)
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
        <SessionSwitcher
          sandboxId={sandboxId}
          sessionId={sessionId}
          onSelect={(id) => setSessionId(id)}
        />
        <span className="text-[10px] uppercase tracking-wide text-neutral-600">native</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {sessionId ? (
          <TranscriptPane
            key={sessionId}
            sessionId={sessionId}
            onOpenShell={onOpenShell}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-neutral-500">
            No session yet.
          </div>
        )}
      </div>
    </div>
  )
}

function TranscriptPane({
  sessionId,
  onOpenShell,
}: {
  sessionId: string
  onOpenShell?: (content: PaneContent) => void
}) {
  const [state, dispatch] = useReducer(reducer, undefined as unknown as TranscriptState, emptyTranscript)

  const messages = trpc.agent.sessionMessages.useQuery(
    { sessionId },
    {
      staleTime: 0,
      refetchOnWindowFocus: false,
    },
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

  // Live-merge events.
  trpc.agent.transcript.useSubscription(
    { sessionId },
    {
      onData(evt) {
        dispatch({
          type: 'event',
          evt: evt as { type: string; payload: Record<string, unknown> },
        })
      },
    },
  )

  const parts = useMemo(() => flattenParts(state), [state])
  const renderables = useMemo(
    () =>
      parts.map((p) => ({
        part: p,
        role: state.messages.get(p.messageID)?.role ?? 'assistant',
      })),
    [parts, state.messages],
  )

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const rowVirtualizer = useVirtualizer({
    count: renderables.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    overscan: 8,
    getItemKey: (i) => renderables[i]!.part.id,
  })

  // Auto-scroll to bottom when new parts arrive and user is near the bottom.
  const lastCount = useRef(0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (renderables.length > lastCount.current && atBottom) {
      el.scrollTop = el.scrollHeight
    }
    lastCount.current = renderables.length
  }, [renderables.length])

  if (messages.isLoading) {
    return <div className="flex flex-1 items-center justify-center text-xs text-neutral-500">Loading…</div>
  }
  if (messages.error) {
    return (
      <div className="p-4 text-xs text-red-400">
        Failed to load transcript: {extractTrpcMessage(messages.error)}
      </div>
    )
  }
  if (renderables.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-neutral-500">
        No messages yet.
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto">
      <div
        className="relative w-full"
        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
      >
        {rowVirtualizer.getVirtualItems().map((v) => {
          const { part, role } = renderables[v.index]!
          return (
            <div
              key={v.key}
              ref={rowVirtualizer.measureElement}
              data-index={v.index}
              className="absolute left-0 right-0 px-4"
              style={{
                transform: `translateY(${v.start}px)`,
                paddingTop: v.index === 0 ? 12 : 4,
                paddingBottom: 4,
              }}
            >
              <PartRenderer
                part={part}
                state={state}
                role={role}
                onOpenShell={onOpenShell}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
