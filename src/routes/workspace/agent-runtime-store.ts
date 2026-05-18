import { useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createCollection, useLiveQuery, type Collection } from '@tanstack/react-db'
import { queryCollectionOptions, type QueryCollectionUtils } from '@tanstack/query-db-collection'
import { envTrpc } from '../../env-trpc'

export type AgentSessionRuntimeRecord = {
  sessionId: string
  workspaceId: string | null
  running: boolean
  pendingAttentionCount: number
  lastActivityAt: Date
  updatedAt: Date
}

type AgentRuntimeCollection = Collection<AgentSessionRuntimeRecord, string> & {
  utils: QueryCollectionUtils<AgentSessionRuntimeRecord, string>
}

type AgentRuntimeSnapshot = {
  table: 'agent_session_runtime'
  rows: Array<Omit<AgentSessionRuntimeRecord, 'lastActivityAt' | 'updatedAt'> & { lastActivityAt: Date | number | string; updatedAt: Date | number | string }>
  seq: number
}

type AgentRuntimeChangeEvent = {
  seq: number
  table: 'agent_session_runtime'
  op: 'insert' | 'update' | 'delete'
  key: string
  row: (Omit<AgentSessionRuntimeRecord, 'lastActivityAt' | 'updatedAt'> & { lastActivityAt: Date | number | string; updatedAt: Date | number | string }) | null
}

function normalizeAgentRuntimeRecord(record: Omit<AgentSessionRuntimeRecord, 'lastActivityAt' | 'updatedAt'> & { lastActivityAt: Date | number | string; updatedAt: Date | number | string }): AgentSessionRuntimeRecord {
  return {
    ...record,
    lastActivityAt: record.lastActivityAt instanceof Date ? record.lastActivityAt : new Date(record.lastActivityAt),
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt : new Date(record.updatedAt),
  }
}

export function useAgentRuntimeStore(workspaceId: string | undefined) {
  const queryClient = useQueryClient()
  const envUtils = envTrpc.useUtils()
  const syncedSeqRef = useRef(0)
  const collectionWorkspaceId = workspaceId ?? '__no_workspace__'
  const collection = useMemo(() => {
    const options = queryCollectionOptions({
      id: `agent-runtime:${collectionWorkspaceId}`,
      queryKey: ['agent-runtime', collectionWorkspaceId],
      queryClient,
      enabled: Boolean(workspaceId),
      getKey: (record: AgentSessionRuntimeRecord) => record.sessionId,
      queryFn: async () => {
        if (!workspaceId) return []
        const snapshot = await envUtils.agentRuntime.snapshot.fetch({ workspaceId }) as AgentRuntimeSnapshot
        syncedSeqRef.current = Math.max(syncedSeqRef.current, snapshot.seq)
        return snapshot.rows.map(normalizeAgentRuntimeRecord)
      },
    })
    return createCollection(options as never) as unknown as AgentRuntimeCollection
  }, [collectionWorkspaceId, envUtils, queryClient, workspaceId])

  envTrpc.agentRuntime.changes.useSubscription(
    { afterSeq: syncedSeqRef.current, workspaceId },
    {
      enabled: Boolean(workspaceId),
      onData(events) {
        const batch = events as AgentRuntimeChangeEvent[]
        if (batch.some((event) => event.op === 'insert' || event.op === 'delete')) {
          void envUtils.agent.sessionList.invalidate({ workspaceId })
        }
        const deduped = new Map<string, AgentRuntimeChangeEvent>()
        for (const event of batch) {
          if (event.seq <= syncedSeqRef.current) continue
          deduped.set(event.key, event)
        }
        collection.utils.writeBatch(() => {
          for (const event of deduped.values()) {
            if (event.op === 'delete') {
              if (collection.has(event.key)) collection.utils.writeDelete(event.key)
            } else if (event.row) {
              collection.utils.writeUpsert(normalizeAgentRuntimeRecord(event.row))
            }
            syncedSeqRef.current = event.seq
          }
        })
      },
    },
  )

  const live = useLiveQuery(() => collection, [collection])
  const records = (live.data ?? []).filter((record) => record.workspaceId === workspaceId)

  return { ...live, records }
}
