import { useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createCollection, useLiveQuery, type Collection } from '@tanstack/react-db'
import { queryCollectionOptions, type QueryCollectionUtils } from '@tanstack/query-db-collection'
import { appTrpcMutation, appTrpcQuery } from '../../lib/trpc-plain'
import { trpc } from '../../trpc'

export type WorkspaceAgentTabRecord = {
  workspaceId: string
  sessionId: string
  position: number
  updatedAt: Date
}

type WorkspaceAgentTabsCollection = Collection<WorkspaceAgentTabRecord, string> & {
  utils: QueryCollectionUtils<WorkspaceAgentTabRecord, string>
}

type WorkspaceAgentTabsSnapshot = {
  table: 'workspace_agent_tabs'
  rows: Array<Omit<WorkspaceAgentTabRecord, 'updatedAt'> & { updatedAt: Date | number | string }>
  seq: number
}

type WorkspaceAgentTabsChangeEvent = {
  seq: number
  table: 'workspace_agent_tabs'
  op: 'insert' | 'update' | 'delete'
  key: string
  row: (Omit<WorkspaceAgentTabRecord, 'updatedAt'> & { updatedAt: Date | number | string }) | null
}

function workspaceAgentTabRecordKey(record: Pick<WorkspaceAgentTabRecord, 'workspaceId' | 'sessionId'>): string {
  return JSON.stringify({ workspace_id: record.workspaceId, session_id: record.sessionId })
}

function normalizeWorkspaceAgentTabRecord(record: Omit<WorkspaceAgentTabRecord, 'updatedAt'> & { updatedAt: Date | number | string }): WorkspaceAgentTabRecord {
  return {
    ...record,
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt : new Date(record.updatedAt),
  }
}

function workspaceAgentSessionIdFromKey(key: unknown): string {
  if (typeof key !== 'string') return String(key)
  try {
    const parsed = JSON.parse(key) as { session_id?: unknown; sessionId?: unknown }
    if (typeof parsed.session_id === 'string') return parsed.session_id
    if (typeof parsed.sessionId === 'string') return parsed.sessionId
  } catch {
    // Fall through for legacy/plain keys.
  }
  return key
}

export function compareWorkspaceAgentTabRecords(a: WorkspaceAgentTabRecord, b: WorkspaceAgentTabRecord): number {
  return a.position - b.position || a.sessionId.localeCompare(b.sessionId)
}

export function useWorkspaceAgentTabsStore(workspaceId: string | undefined) {
  const queryClient = useQueryClient()
  const syncedSeqRef = useRef(0)
  const collectionWorkspaceId = workspaceId ?? '__no_workspace__'
  const collection = useMemo(() => {
    const options = queryCollectionOptions({
      id: `workspace-agent-tabs:${collectionWorkspaceId}`,
      queryKey: ['sync', 'workspace_agent_tabs'],
      queryClient,
      enabled: Boolean(workspaceId),
      getKey: workspaceAgentTabRecordKey,
      queryFn: async () => {
        if (!workspaceId) return []
        const snapshot = await appTrpcQuery<WorkspaceAgentTabsSnapshot>('sync.snapshot', { table: 'workspace_agent_tabs' })
        syncedSeqRef.current = Math.max(syncedSeqRef.current, snapshot.seq)
        return snapshot.rows.map(normalizeWorkspaceAgentTabRecord)
      },
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
          await appTrpcMutation('workspace.deleteAgentTab', { workspaceId, sessionId: workspaceAgentSessionIdFromKey(mutation.key) })
        }
      },
    })
    return createCollection(options as never) as unknown as WorkspaceAgentTabsCollection
  }, [collectionWorkspaceId, queryClient, workspaceId])

  trpc.sync.changes.useSubscription(
    { afterSeq: syncedSeqRef.current, tables: ['workspace_agent_tabs'] },
    {
      enabled: Boolean(workspaceId),
      onData(events) {
        const batch = events as WorkspaceAgentTabsChangeEvent[]
        const deduped = new Map<string, WorkspaceAgentTabsChangeEvent>()
        for (const event of batch) {
          if (event.seq <= syncedSeqRef.current) continue
          deduped.set(event.key, event)
        }
        collection.utils.writeBatch(() => {
          for (const event of deduped.values()) {
            if (event.op === 'delete') {
              collection.utils.writeDelete(event.key)
            } else if (event.row) {
              collection.utils.writeUpsert(normalizeWorkspaceAgentTabRecord(event.row))
            }
            syncedSeqRef.current = event.seq
          }
        })
      },
    },
  )

  const live = useLiveQuery(() => collection, [collection])
  const records = (live.data ?? []).filter((record) => record.workspaceId === workspaceId).slice().sort(compareWorkspaceAgentTabRecords)

  return {
    ...live,
    records,
    ensureSession(sessionId: string): void {
      if (!workspaceId) return
      const key = workspaceAgentTabRecordKey({ workspaceId, sessionId })
      if (collection.has(key)) return
      const position = Array.from(collection.values())
        .filter((record) => record.workspaceId === workspaceId)
        .reduce((max, record) => Math.max(max, record.position), -1) + 1
      collection.insert({ workspaceId, sessionId, position, updatedAt: new Date() })
    },
    deleteSession(sessionId: string): void {
      if (!workspaceId) return
      const key = workspaceAgentTabRecordKey({ workspaceId, sessionId })
      if (collection.has(key)) collection.delete(key)
    },
  }
}
