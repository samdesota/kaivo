import { useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createCollection, useLiveQuery, type Collection } from '@tanstack/react-db'
import { queryCollectionOptions, type QueryCollectionUtils } from '@tanstack/query-db-collection'
import { appTrpcMutation, appTrpcQuery } from '../../lib/trpc-plain'
import { trpc } from '../../trpc'

export type WorkspaceResourceType = 'browser_tab' | 'worktree' | 'shell' | 'other'

export type WorkspaceResourceRecord = {
  id: string
  workspaceId: string
  type: WorkspaceResourceType
  resourceKey: string
  shared: boolean
  data: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

type WorkspaceResourcesCollection = Collection<WorkspaceResourceRecord, string> & {
  utils: QueryCollectionUtils<WorkspaceResourceRecord, string>
}

type RawWorkspaceResourceRecord = Omit<WorkspaceResourceRecord, 'shared' | 'createdAt' | 'updatedAt'> & { shared: boolean | number; createdAt: Date | number | string; updatedAt: Date | number | string }

type WorkspaceResourcesSnapshot = {
  table: 'workspace_resources'
  rows: RawWorkspaceResourceRecord[]
  seq: number
}

type WorkspaceResourcesChangeEvent = {
  seq: number
  table: 'workspace_resources'
  op: 'insert' | 'update' | 'delete'
  key: string
  row: RawWorkspaceResourceRecord | null
}

function normalizeWorkspaceResourceRecord(record: RawWorkspaceResourceRecord): WorkspaceResourceRecord {
  return {
    ...record,
    shared: record.shared === true || record.shared === 1,
    data: normalizeResourceData(record.data),
    createdAt: record.createdAt instanceof Date ? record.createdAt : new Date(record.createdAt),
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt : new Date(record.updatedAt),
  }
}

function normalizeResourceData(data: unknown): Record<string, unknown> {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      return {}
    }
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {}
}

export function useWorkspaceResourcesStore(workspaceId?: string) {
  const queryClient = useQueryClient()
  const syncedSeqRef = useRef(0)
  const collection = useMemo(() => {
    const options = queryCollectionOptions({
      id: 'workspace-resources',
      queryKey: ['sync', 'workspace_resources'],
      queryClient,
      getKey: (record: WorkspaceResourceRecord) => record.id,
      queryFn: async () => {
        const snapshot = await appTrpcQuery<WorkspaceResourcesSnapshot>('sync.snapshot', { table: 'workspace_resources' })
        syncedSeqRef.current = Math.max(syncedSeqRef.current, snapshot.seq)
        return snapshot.rows.map(normalizeWorkspaceResourceRecord)
      },
      onInsert: async ({ transaction }: { transaction: { mutations: Array<{ modified: unknown }> } }) => {
        for (const mutation of transaction.mutations) {
          const record = mutation.modified as WorkspaceResourceRecord
          await appTrpcMutation('workspace.upsertResource', {
            workspaceId: record.workspaceId,
            resource: { type: record.type, resourceKey: record.resourceKey, shared: record.shared, data: record.data },
          })
        }
      },
      onUpdate: async ({ transaction }: { transaction: { mutations: Array<{ modified: unknown }> } }) => {
        for (const mutation of transaction.mutations) {
          const record = mutation.modified as WorkspaceResourceRecord
          await appTrpcMutation('workspace.upsertResource', {
            workspaceId: record.workspaceId,
            resource: { type: record.type, resourceKey: record.resourceKey, shared: record.shared, data: record.data },
          })
        }
      },
      onDelete: async ({ transaction }: { transaction: { mutations: Array<{ key: unknown }> } }) => {
        for (const mutation of transaction.mutations) {
          await appTrpcMutation('workspace.deleteResource', { id: String(mutation.key) })
        }
      },
    })
    return createCollection(options as never) as unknown as WorkspaceResourcesCollection
  }, [queryClient])

  trpc.sync.changes.useSubscription(
    { afterSeq: syncedSeqRef.current, tables: ['workspace_resources'] },
    {
      onData(events) {
        const batch = events as WorkspaceResourcesChangeEvent[]
        const deduped = new Map<string, WorkspaceResourcesChangeEvent>()
        for (const event of batch) {
          if (event.seq <= syncedSeqRef.current) continue
          deduped.set(event.key, event)
        }
        collection.utils.writeBatch(() => {
          for (const event of deduped.values()) {
            if (event.op === 'delete') {
              collection.utils.writeDelete(event.key)
            } else if (event.row) {
              collection.utils.writeUpsert(normalizeWorkspaceResourceRecord(event.row))
            }
            syncedSeqRef.current = event.seq
          }
        })
      },
    },
  )

  const live = useLiveQuery(() => collection, [collection])
  const records = (live.data ?? []).filter((record) => !workspaceId || record.workspaceId === workspaceId)

  return {
    ...live,
    records,
  }
}
