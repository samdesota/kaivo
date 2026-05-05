import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createCollection, useLiveQuery, type Collection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { appTrpcMutation, appTrpcQuery } from '../../lib/trpc-plain'

export type WorkspaceViewStateRecord = {
  workspaceId: string
  activeAgentSessionId: string | null
  activeWorkspaceTabId: string | null
  splitRatio: number | null
  agentCollapsed: boolean
  updatedAt: Date
}

type WorkspaceViewStatePatch = Partial<Pick<
  WorkspaceViewStateRecord,
  'activeAgentSessionId' | 'activeWorkspaceTabId' | 'splitRatio' | 'agentCollapsed'
>>

export function useWorkspaceViewStateStore(workspaceId: string) {
  const queryClient = useQueryClient()
  const collection = useMemo(() => {
    const options = queryCollectionOptions({
      id: `workspace-view-state:${workspaceId}`,
      queryKey: ['workspace-view-state', workspaceId],
      queryClient,
      getKey: (state: WorkspaceViewStateRecord) => state.workspaceId,
      queryFn: async () => [await appTrpcQuery<WorkspaceViewStateRecord>('workspace.getViewState', { workspaceId })],
      onUpdate: async ({ transaction }: { transaction: { mutations: Array<{ modified: unknown }> } }) => {
        const mutation = transaction.mutations[0]
        if (!mutation) return
        const modified = mutation.modified as WorkspaceViewStateRecord
        await appTrpcMutation('workspace.saveViewState', {
          workspaceId: modified.workspaceId,
          state: {
            activeAgentSessionId: modified.activeAgentSessionId,
            activeWorkspaceTabId: modified.activeWorkspaceTabId,
            splitRatio: modified.splitRatio,
            agentCollapsed: modified.agentCollapsed,
          },
        })
      },
    })
    return createCollection(options as never) as unknown as Collection<WorkspaceViewStateRecord, string>
  }, [queryClient, workspaceId])

  const live = useLiveQuery(() => collection, [collection])
  const viewState = live.data?.[0]

  const update = (patch: WorkspaceViewStatePatch) => {
    const current = collection.get(workspaceId)
    if (!current) return
    collection.update(workspaceId, (draft) => {
      if ('activeAgentSessionId' in patch) draft.activeAgentSessionId = patch.activeAgentSessionId ?? null
      if ('activeWorkspaceTabId' in patch) draft.activeWorkspaceTabId = patch.activeWorkspaceTabId ?? null
      if ('splitRatio' in patch) draft.splitRatio = patch.splitRatio ?? null
      if ('agentCollapsed' in patch && patch.agentCollapsed !== undefined) draft.agentCollapsed = patch.agentCollapsed
    })
  }

  return {
    ...live,
    viewState,
    setActiveAgentSession: (sessionId: string | null) => update({ activeAgentSessionId: sessionId }),
    setActiveWorkspaceTab: (tabId: string | null) => update({ activeWorkspaceTabId: tabId }),
    setSplitRatio: (splitRatio: number | null) => update({ splitRatio }),
    setAgentCollapsed: (agentCollapsed: boolean) => update({ agentCollapsed }),
  }
}
