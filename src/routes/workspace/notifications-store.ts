import { useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createCollection, useLiveQuery, type Collection } from '@tanstack/react-db'
import { queryCollectionOptions, type QueryCollectionUtils } from '@tanstack/query-db-collection'
import { appTrpcMutation, appTrpcQuery } from '../../lib/trpc-plain'
import { trpc } from '../../trpc'

export type AgentNotificationRecord = {
  id: string
  workspaceId: string
  sessionId: string
  kind: 'finished' | 'question' | 'permission' | 'error'
  title: string
  summary: string
  createdAt: Date
}

type AgentNotificationsCollection = Collection<AgentNotificationRecord, string> & {
  utils: QueryCollectionUtils<AgentNotificationRecord, string>
}

type AgentNotificationsSnapshot = {
  table: 'agent_notifications'
  rows: Array<Omit<AgentNotificationRecord, 'createdAt'> & { createdAt: Date | number | string }>
  seq: number
}

type AgentNotificationsChangeEvent = {
  seq: number
  table: 'agent_notifications'
  op: 'insert' | 'update' | 'delete'
  key: string
  row: (Omit<AgentNotificationRecord, 'createdAt'> & { createdAt: Date | number | string }) | null
}

function normalizeAgentNotificationRecord(record: Omit<AgentNotificationRecord, 'createdAt'> & { createdAt: Date | number | string }): AgentNotificationRecord {
  return {
    ...record,
    kind: record.kind ?? 'finished',
    title: record.title || 'Chat finished',
    createdAt: record.createdAt instanceof Date ? record.createdAt : new Date(record.createdAt),
  }
}

export function compareAgentNotificationRecords(a: AgentNotificationRecord, b: AgentNotificationRecord): number {
  return b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)
}

export function useAgentNotificationsStore() {
  const queryClient = useQueryClient()
  const syncedSeqRef = useRef(0)
  const collection = useMemo(() => {
    const options = queryCollectionOptions({
      id: 'agent-notifications',
      queryKey: ['sync', 'agent_notifications'],
      queryClient,
      getKey: (notification: AgentNotificationRecord) => notification.id,
      queryFn: async () => {
        const snapshot = await appTrpcQuery<AgentNotificationsSnapshot>('sync.snapshot', { table: 'agent_notifications' })
        syncedSeqRef.current = Math.max(syncedSeqRef.current, snapshot.seq)
        return snapshot.rows.map(normalizeAgentNotificationRecord)
      },
      onDelete: async ({ transaction }: { transaction: { mutations: Array<{ key: unknown }> } }) => {
        for (const mutation of transaction.mutations) {
          await appTrpcMutation('workspace.dismissAgentNotification', { id: String(mutation.key) })
        }
      },
    })
    return createCollection(options as never) as unknown as AgentNotificationsCollection
  }, [queryClient])

  trpc.sync.changes.useSubscription(
    { afterSeq: syncedSeqRef.current, tables: ['agent_notifications'] },
    {
      onData(events) {
        const batch = events as AgentNotificationsChangeEvent[]
        const deduped = new Map<string, AgentNotificationsChangeEvent>()
        for (const event of batch) {
          if (event.seq <= syncedSeqRef.current) continue
          deduped.set(event.key, event)
        }
        collection.utils.writeBatch(() => {
          for (const event of deduped.values()) {
            if (event.op === 'delete') {
              collection.utils.writeDelete(event.key)
            } else if (event.row) {
              collection.utils.writeUpsert(normalizeAgentNotificationRecord(event.row))
            }
            syncedSeqRef.current = event.seq
          }
        })
      },
    },
  )

  const live = useLiveQuery(() => collection, [collection])
  const records = (live.data ?? []).slice().sort(compareAgentNotificationRecords)

  return {
    ...live,
    records,
    dismiss(id: string): void {
      if (collection.has(id)) collection.delete(id)
    },
    async dismissForSession(sessionId: string): Promise<void> {
      await appTrpcMutation('workspace.dismissAgentNotificationsForSession', { sessionId })
    },
  }
}
