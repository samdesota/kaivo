export type OrchestrationCursor = { generation: string; seq: number }
export type OrchestrationChange =
  | { type: 'changed'; cursor: OrchestrationCursor }
  | { type: 'stale'; cursor: OrchestrationCursor }

export type OrchestrationRecoveryTask = {
  state: 'provisioning' | 'active' | 'returned' | 'completed' | 'failed'
  provisioningStage: 'reserved' | 'worktree_created' | 'session_created' | 'prompt_accepted' | null
  sessionId: string | null
  sessionStatus?: 'active' | 'archived' | null
  failure: { stage: string; retryable: boolean; residualArtifacts: string[] } | null
}

export type OrchestrationRecovery = {
  kind: 'progress' | 'retryable-failure' | 'worktree-integrity' | 'terminal-failure' | 'normal'
  canRetry: boolean
  canSend: boolean
  sendDisabledReason?: string
}

export function provisioningStageLabel(stage: OrchestrationRecoveryTask['provisioningStage']): string {
  const labels = {
    reserved: 'Reserving task',
    worktree_created: 'Creating agent session',
    session_created: 'Sending initial task',
    prompt_accepted: 'Starting agent',
  }
  return stage ? labels[stage] : 'Provisioning'
}

export function orchestrationRecovery(task: OrchestrationRecoveryTask): OrchestrationRecovery {
  if (task.state === 'provisioning') return { kind: 'progress', canRetry: false, canSend: false }
  if (task.sessionStatus === 'archived') {
    return {
      kind: 'normal',
      canRetry: false,
      canSend: false,
      sendDisabledReason: 'This task chat is archived. Reopen it to send messages.',
    }
  }
  if (task.state !== 'failed') return { kind: 'normal', canRetry: false, canSend: Boolean(task.sessionId) }
  if (task.failure?.stage === 'worktree_integrity') {
    return {
      kind: 'worktree-integrity',
      canRetry: false,
      canSend: false,
      sendDisabledReason: 'This task worktree is missing or moved. Request a replacement task from the dispatcher.',
    }
  }
  if (task.failure?.retryable) return { kind: 'retryable-failure', canRetry: true, canSend: false }
  return { kind: 'terminal-failure', canRetry: false, canSend: false }
}

export function orchestrationSelectionKey(envId: string, workspaceId: string): string {
  return `kaivo:orchestration-selection:${envId}:${workspaceId}`
}

export function readOrchestrationSelection(envId: string, workspaceId: string): string | null {
  try {
    return window.localStorage.getItem(orchestrationSelectionKey(envId, workspaceId))
  } catch {
    return null
  }
}

export function writeOrchestrationSelection(envId: string, workspaceId: string, selectedId: string): void {
  try {
    window.localStorage.setItem(orchestrationSelectionKey(envId, workspaceId), selectedId)
  } catch {
    // Selection persistence is presentation-only.
  }
}

export class OrchestrationReplayState {
  private cursor: OrchestrationCursor | null = null

  replace(cursor: OrchestrationCursor): void {
    this.cursor = cursor
  }

  accept(change: OrchestrationChange): 'ignore' | 'refresh' | 'replace' {
    if (!this.cursor || change.type === 'stale' || change.cursor.generation !== this.cursor.generation) {
      this.cursor = change.cursor
      return 'replace'
    }
    if (change.cursor.seq <= this.cursor.seq) return 'ignore'
    if (change.cursor.seq !== this.cursor.seq + 1) {
      this.cursor = change.cursor
      return 'replace'
    }
    this.cursor = change.cursor
    return 'refresh'
  }
}

export type AggregateTask = {
  state: 'provisioning' | 'active' | 'returned' | 'completed' | 'failed'
  running: boolean
  pendingAttentionCount: number
}

export function orchestrationAggregates(tasks: AggregateTask[]) {
  return {
    running: tasks.filter((task) => task.running).length,
    returned: tasks.filter((task) => task.state === 'returned').length,
    attention: tasks.filter((task) => task.pendingAttentionCount > 0).length,
    failed: tasks.filter((task) => task.state === 'failed').length,
    completed: tasks.filter((task) => task.state === 'completed').length,
  }
}

export function formatAggregateDetail(tasks: AggregateTask[]): string {
  const counts = orchestrationAggregates(tasks)
  const parts = [
    counts.running ? `${counts.running} running` : '',
    counts.returned ? `${counts.returned} returned` : '',
    counts.attention ? `${counts.attention} attention` : '',
    counts.failed ? `${counts.failed} failed` : '',
    counts.completed ? `${counts.completed} completed` : '',
  ].filter(Boolean)
  return parts.join(' · ') || 'Dispatcher'
}

export function replaceOrchestrationSubtask<T extends {
  dispatches: Array<{ subtasks: Array<{ id: string }> }>
}>(snapshot: T | undefined, subtask: { id: string } & Record<string, unknown>): T | undefined {
  if (!snapshot) return snapshot
  return {
    ...snapshot,
    dispatches: snapshot.dispatches.map((dispatch) => ({
      ...dispatch,
      subtasks: dispatch.subtasks.map((candidate) => candidate.id === subtask.id ? subtask as typeof candidate : candidate),
    })),
  }
}

type IdentifiedCreated = { id: string; createdAt?: string }

export function normalizeOrchestrationSnapshot<T extends {
  dispatches: Array<IdentifiedCreated & { subtasks: IdentifiedCreated[] }>
}>(snapshot: T): T {
  const dispatches = dedupeAndSort(snapshot.dispatches).map((dispatch) => ({
    ...dispatch,
    subtasks: dedupeAndSort(dispatch.subtasks),
  }))
  return { ...snapshot, dispatches } as T
}

function dedupeAndSort<T extends IdentifiedCreated>(values: T[]): T[] {
  const byId = new Map<string, T>()
  for (const value of values) byId.set(value.id, value)
  return [...byId.values()].sort((a, b) => {
    const created = (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
    return created || a.id.localeCompare(b.id)
  })
}

export function resolveOrchestrationSelection(
  dispatches: Array<{ id: string; subtasks: Array<{ id: string }> }>,
  preferredId: string | null,
  currentDispatchId: string,
): string | null {
  const exists = (id: string | null) => Boolean(id && dispatches.some((dispatch) =>
    dispatch.id === id || dispatch.subtasks.some((task) => task.id === id)))
  if (exists(preferredId)) return preferredId
  if (exists(currentDispatchId)) return currentDispatchId
  return dispatches[0]?.id ?? null
}

export function relevantOrchestrationSessionIds(
  dispatches: Array<{ id: string; status?: string; subtasks: Array<{
    sessionId: string | null
    sessionStatus?: string | null
    running: boolean
    pendingAttentionCount: number
  }> }>,
  selectedSessionId: string | null,
): string[] {
  const ids = new Set<string>()
  if (selectedSessionId) ids.add(selectedSessionId)
  for (const dispatch of dispatches) {
    for (const task of dispatch.subtasks) {
      if (task.sessionId && task.sessionStatus !== 'archived' && (task.running || task.pendingAttentionCount > 0)) {
        ids.add(task.sessionId)
      }
    }
  }
  return [...ids].sort()
}
