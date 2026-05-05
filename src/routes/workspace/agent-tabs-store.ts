import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createCollection, useLiveQuery, type Collection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { appTrpcMutation, appTrpcQuery } from '../../lib/trpc-plain'

export type WorkspaceAgentTabRecord = {
  workspaceId: string
  sessionId: string
  position: number
  updatedAt: Date
}

export function compareWorkspaceAgentTabRecords(a: WorkspaceAgentTabRecord, b: WorkspaceAgentTabRecord): number {
  return a.position - b.position || a.sessionId.localeCompare(b.sessionId)
}

export function useWorkspaceAgentTabsStore(workspaceId: string | undefined) {
  const queryClient = useQueryClient()
  const collectionWorkspaceId = workspaceId ?? '__no_workspace__'
  const collection = useMemo(() => {
    const options = queryCollectionOptions({
      id: `workspace-agent-tabs:${collectionWorkspaceId}`,
      queryKey: ['workspace-agent-tabs', collectionWorkspaceId],
      queryClient,
      enabled: Boolean(workspaceId),
      getKey: (tab: WorkspaceAgentTabRecord) => tab.sessionId,
      queryFn: async () => workspaceId ? await appTrpcQuery<WorkspaceAgentTabRecord[]>('workspace.listAgentTabs', { workspaceId }) : [],
      onInsert: async ({ transaction }: { transaction: { mutations: Array<{ modified: unknown }> } }) => {
        for (const mutation of transaction.mutations) {
          const record = mutation.modified as WorkspaceAgentTabRecord
          await appTrpcMutation('workspace.upsertAgentTab', {
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            position: record.position,
          })
        }
      },
      onUpdate: async ({ transaction }: { transaction: { mutations: Array<{ modified: unknown }> } }) => {
        for (const mutation of transaction.mutations) {
          const record = mutation.modified as WorkspaceAgentTabRecord
          await appTrpcMutation('workspace.upsertAgentTab', {
            workspaceId: record.workspaceId,
            sessionId: record.sessionId,
            position: record.position,
          })
        }
      },
      onDelete: async ({ transaction }: { transaction: { mutations: Array<{ key: unknown }> } }) => {
        if (!workspaceId) return
        for (const mutation of transaction.mutations) {
          await appTrpcMutation('workspace.deleteAgentTab', { workspaceId, sessionId: String(mutation.key) })
        }
      },
    })
    return createCollection(options as never) as unknown as Collection<WorkspaceAgentTabRecord, string>
  }, [collectionWorkspaceId, queryClient, workspaceId])

  const live = useLiveQuery(() => collection, [collection])
  const records = (live.data ?? []).slice().sort(compareWorkspaceAgentTabRecords)

  return {
    ...live,
    records,
    ensureSession(sessionId: string): void {
      if (!workspaceId || collection.has(sessionId)) return
      const position = Array.from(collection.values()).reduce((max, record) => Math.max(max, record.position), -1) + 1
      collection.insert({ workspaceId, sessionId, position, updatedAt: new Date() })
    },
    deleteSession(sessionId: string): void {
      if (collection.has(sessionId)) collection.delete(sessionId)
    },
  }
}
