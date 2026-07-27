import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { envTrpc } from '../../../env-trpc'
import { trpcQueryKey } from '../../../lib/trpc-plain'
import {
  normalizeOrchestrationSnapshot,
  formatAggregateDetail,
  orchestrationRecovery,
  OrchestrationReplayState,
  provisioningStageLabel,
  relevantOrchestrationSessionIds,
  type OrchestrationChange,
  type OrchestrationCursor,
} from './orchestration-store'
import { replaceOrchestrationSubtask } from './orchestration-store'
import { useEnv } from '../env-context'
import { openTaskCompletionOverlay } from '../../../lib/overlay-layer-controller'
import { DeliveryMetadata, type DeliveryMetadataValue } from './delivery-metadata'
import { useRetainChatSessions } from './chat-state'

type Failure = {
  stage: string
  message: string
  retryable: boolean
  residualArtifacts: string[]
}

type Subtask = {
  id: string
  sessionId: string | null
  sessionStatus: 'active' | 'archived' | null
  title: string
  state: 'provisioning' | 'active' | 'returned' | 'completed' | 'failed'
  provisioningStage: 'reserved' | 'worktree_created' | 'session_created' | 'prompt_accepted' | null
  sourceRef: string
  branchName: string
  deliveryMode: 'pull_request' | 'dispatcher_integration'
  delivery: DeliveryMetadataValue['delivery']
  worktreePath: string | null
  failure: Failure | null
  latestReturn: { kind: 'response' | 'error'; summary: string; sequence: number } | null
  running: boolean
  pendingAttentionCount: number
  completedAt: string | null
}

type Dispatch = {
  id: string
  title: string | null
  status: 'active' | 'archived'
  workingDir: string | null
  createdAt: string
  subtasks: Subtask[]
}

export function usesOrchestrationView(kind: string | undefined, workspaceId: string | undefined, selectedSubtask = false): boolean {
  return Boolean(workspaceId) && (kind === 'dispatch' || selectedSubtask)
}

export function OrchestrationSessionView({
  workspaceId,
  sessionId,
  sessionWorkingDir,
  renderChat,
}: {
  workspaceId: string
  sessionId: string
  sessionWorkingDir?: string
  renderChat: (sessionId: string, workingDir?: string, options?: { sendDisabledReason?: string }) => ReactNode
}) {
  const queryClient = useQueryClient()
  const utils = envTrpc.useUtils()
  const envContext = useEnv()
  const snapshot = envTrpc.orchestration.snapshot.useQuery({ workspaceId })
  const rawSnapshotData = snapshot.data as { cursor: OrchestrationCursor; dispatches: Dispatch[] } | undefined
  const snapshotData = useMemo(() => rawSnapshotData ? normalizeOrchestrationSnapshot(rawSnapshotData) : undefined, [rawSnapshotData])
  const [expanded, setExpanded] = useState(false)
  const replayRef = useRef(new OrchestrationReplayState())
  const completeTask = envTrpc.orchestration.complete.useMutation({
    onSuccess(task) {
      utils.orchestration.snapshot.setData(
        { workspaceId },
        (current) => replaceOrchestrationSubtask(current as typeof snapshotData, task as Subtask) as typeof current,
      )
    },
  })
  const retryTask = envTrpc.orchestration.retry.useMutation({
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: trpcQueryKey('orchestration.snapshot', { workspaceId }) })
    },
  })
  const archiveSession = envTrpc.agent.sessionClose.useMutation({
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: trpcQueryKey('orchestration.snapshot', { workspaceId }) })
    },
  })
  const reopenSession = envTrpc.agent.sessionReopen.useMutation({
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: trpcQueryKey('orchestration.snapshot', { workspaceId }) })
    },
  })

  useEffect(() => {
    if (snapshotData?.cursor) replayRef.current.replace(snapshotData.cursor)
  }, [snapshotData?.cursor])

  envTrpc.orchestration.changes.useSubscription(
    { workspaceId, cursor: snapshotData?.cursor ?? { generation: '', seq: 0 } },
    {
      onData(change: OrchestrationChange) {
        if (replayRef.current.accept(change) === 'ignore') return
        void queryClient.invalidateQueries({ queryKey: trpcQueryKey('orchestration.snapshot', { workspaceId }) })
      },
    },
  )

  const selectedDispatch = snapshotData?.dispatches.find((item) => item.id === sessionId)
    ?? snapshotData?.dispatches.find((item) => item.subtasks.some((task) => task.sessionId === sessionId))
    ?? null
  const selectedSubtask = selectedDispatch?.subtasks.find((item) => item.sessionId === sessionId) ?? null
  const selectedWorkingDir = selectedSubtask?.worktreePath ?? selectedDispatch?.workingDir ?? sessionWorkingDir
  const selectedRecovery = selectedSubtask ? orchestrationRecovery(selectedSubtask) : null
  const retainedSessionIds = useMemo(
    () => relevantOrchestrationSessionIds(snapshotData?.dispatches ?? [], sessionId),
    [sessionId, snapshotData?.dispatches],
  )
  useRetainChatSessions(retainedSessionIds)

  async function markComplete(task: Subtask) {
    const confirmed = await openTaskCompletionOverlay({
      ...envContext,
      title: task.title,
      task,
    })
    if (!confirmed) return
    completeTask.mutate({ workspaceId, subtaskId: task.id })
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-975" data-orchestration-chat>
      {selectedDispatch && (
        <div className={`shrink-0 border-b border-neutral-800 bg-neutral-950/70 ${selectedSubtask?.state === 'completed' ? 'opacity-70' : ''}`}>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left hover:bg-neutral-900/70"
          >
            <span className="text-[10px] text-neutral-600" aria-hidden="true">{expanded ? '▼' : '▶'}</span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-200">
              {selectedSubtask?.title ?? 'Task state'}
            </span>
            <span className="truncate text-[10px] text-neutral-500">
              {selectedSubtask
                ? `${selectedSubtask.state}${selectedSubtask.pendingAttentionCount ? ` · ${selectedSubtask.pendingAttentionCount} attention` : ''}`
                : `${selectedDispatch.subtasks.length} tasks · ${formatAggregateDetail(selectedDispatch.subtasks)}`}
            </span>
          </button>
          {expanded && (
            <div className="border-t border-neutral-800 px-4 py-3">
              {selectedSubtask ? (
                <>
                  <DeliveryMetadata value={selectedSubtask} />
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(selectedSubtask.state === 'active' || selectedSubtask.state === 'returned') && (
                      <button type="button" disabled={completeTask.isPending} onClick={() => void markComplete(selectedSubtask)} className="rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800 disabled:opacity-50">
                        {completeTask.isPending ? 'Completing…' : 'Mark complete'}
                      </button>
                    )}
                    {selectedSubtask.sessionId && (
                      <button
                        type="button"
                        disabled={archiveSession.isPending || reopenSession.isPending}
                        onClick={() => selectedSubtask.sessionId && (selectedSubtask.sessionStatus === 'archived'
                          ? reopenSession.mutate({ sessionId: selectedSubtask.sessionId })
                          : archiveSession.mutate({ sessionId: selectedSubtask.sessionId }))}
                        className="rounded border border-neutral-800 px-2.5 py-1 text-xs text-neutral-400 hover:bg-neutral-900 disabled:opacity-50"
                      >
                        {selectedSubtask.sessionStatus === 'archived' ? 'Reopen chat' : 'Archive chat'}
                      </button>
                    )}
                  </div>
                  {(selectedSubtask.failure || selectedSubtask.state === 'provisioning') && (
                    <SubtaskRecoveryPane
                      task={selectedSubtask}
                      compact
                      retryPending={retryTask.isPending}
                      retryError={retryTask.error?.message}
                      onRetry={() => retryTask.mutate({ workspaceId, subtaskId: selectedSubtask.id })}
                    />
                  )}
                </>
              ) : (
                <div className="space-y-1 text-xs text-neutral-500">
                  {selectedDispatch.subtasks.length === 0 ? 'No tasks dispatched yet.' : selectedDispatch.subtasks.map((task) => (
                    <div key={task.id} className="flex min-w-0 gap-2">
                      <span className="min-w-0 flex-1 truncate text-neutral-300">{task.title}</span>
                      <span className="shrink-0">{task.state}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        {renderChat(sessionId, selectedWorkingDir ?? undefined, {
          ...(selectedRecovery?.sendDisabledReason
            ? { sendDisabledReason: selectedRecovery.sendDisabledReason }
            : selectedDispatch?.status === 'archived'
              ? { sendDisabledReason: 'This dispatch chat is archived. Reopen it to send messages.' }
              : {}),
        })}
      </div>
    </div>
  )
}

function SubtaskRecoveryPane({
  task,
  compact = false,
  retryPending,
  retryError,
  onRetry,
}: {
  task: Subtask | null
  compact?: boolean
  retryPending: boolean
  retryError?: string
  onRetry: () => void
}) {
  if (!task) return <div className="flex flex-1 items-center justify-center text-xs text-neutral-500">Select a task.</div>
  const recovery = orchestrationRecovery(task)
  if (task.failure) {
    return (
      <div className={compact ? 'shrink-0 border-b border-red-900/60 bg-red-950/20 px-4 py-3' : 'm-auto max-w-md p-6 text-center'}>
        <div className="text-sm font-medium text-red-300">{recovery.kind === 'worktree-integrity' ? 'Task worktree unavailable' : 'Task provisioning failed'}</div>
        <div className="mt-1 text-xs text-neutral-400">{task.failure.message}</div>
        <div className="mt-1 font-mono text-[10px] text-neutral-600">Stage: {task.failure.stage} · {task.failure.retryable ? 'safe to retry' : 'not retryable'}</div>
        {task.failure.residualArtifacts.length > 0 && (
          <div className="mt-2 text-left text-[10px] text-neutral-500">
            <div className="font-medium uppercase tracking-wide">Retained artifacts</div>
            {task.failure.residualArtifacts.map((artifact) => <div key={artifact} className="break-all font-mono">{artifact}</div>)}
          </div>
        )}
        {recovery.kind === 'worktree-integrity' && (
          <div className="mt-2 text-xs text-amber-300">The worktree will not be recreated over potentially recoverable work. Request a replacement dispatch.</div>
        )}
        <div className={`mt-3 flex gap-2 ${compact ? '' : 'justify-center'}`}>
          {recovery.canRetry && (
            <button type="button" disabled={retryPending} onClick={onRetry} className="rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50">
              {retryPending ? 'Retrying…' : 'Retry provisioning'}
            </button>
          )}
        </div>
        {retryError && <div className="mt-2 text-xs text-red-300">{retryError}</div>}
      </div>
    )
  }
  return (
    <div className="m-auto max-w-md p-6 text-center">
      <div className="text-sm font-medium text-neutral-200">Preparing task workspace</div>
      <div className="mt-2 text-xs text-amber-300">{provisioningStageLabel(task.provisioningStage)}</div>
      <div className="mt-3 font-mono text-[10px] text-neutral-600">{task.sourceRef} → {task.branchName}</div>
    </div>
  )
}
