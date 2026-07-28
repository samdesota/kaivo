import { useMemo, useRef, useState } from 'react'
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

export function applyAgentRuntimeChangeEvents(input: {
  events: AgentRuntimeChangeEvent[]
  collectionUtils: QueryCollectionUtils<AgentSessionRuntimeRecord, string>
  collectionHas: (key: string) => boolean
  syncedSeq: number
}): number {
  let nextSeq = input.syncedSeq
  const deduped = new Map<string, AgentRuntimeChangeEvent>()
  for (const event of input.events) {
    if (event.seq <= input.syncedSeq) continue
    deduped.set(event.key, event)
  }
  input.collectionUtils.writeBatch(() => {
    for (const event of deduped.values()) {
      if (event.op === 'delete') {
        if (input.collectionHas(event.key)) input.collectionUtils.writeDelete(event.key)
      } else if (event.row) {
        input.collectionUtils.writeUpsert(normalizeAgentRuntimeRecord(event.row))
      }
      nextSeq = Math.max(nextSeq, event.seq)
    }
  })
  return nextSeq
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
  const lastSnapshotRef = useRef<{ workspaceId: string; seq: number } | null>(null)
  const [snapshotCursor, setSnapshotCursor] = useState<{ workspaceId: string; seq: number } | null>(null)
  const collectionWorkspaceId = workspaceId ?? '__no_workspace__'
  const collection = useMemo(() => {
    const options = queryCollectionOptions({
      id: `agent-runtime:${collectionWorkspaceId}`,
      queryKey: ['agent-runtime', collectionWorkspaceId],
      queryClient,
      enabled: Boolean(workspaceId),
      refetchInterval: 5_000,
      getKey: (record: AgentSessionRuntimeRecord) => record.sessionId,
      queryFn: async () => {
        if (!workspaceId) return []
        const snapshot = await envUtils.agentRuntime.snapshot.fetch({ workspaceId }) as AgentRuntimeSnapshot
        const previousSnapshot = lastSnapshotRef.current
        if (!previousSnapshot || previousSnapshot.workspaceId !== workspaceId || snapshot.seq < previousSnapshot.seq) {
          syncedSeqRef.current = snapshot.seq
          setSnapshotCursor({ workspaceId, seq: snapshot.seq })
        } else {
          syncedSeqRef.current = Math.max(syncedSeqRef.current, snapshot.seq)
        }
        lastSnapshotRef.current = { workspaceId, seq: snapshot.seq }
        return snapshot.rows.map(normalizeAgentRuntimeRecord)
      },
    })
    return createCollection(options as never) as unknown as AgentRuntimeCollection
  }, [collectionWorkspaceId, envUtils, queryClient, workspaceId])

  const snapshotReady = snapshotCursor !== null && snapshotCursor.workspaceId === workspaceId
  envTrpc.agentRuntime.changes.useSubscription(
    {
      afterSeq: snapshotReady ? snapshotCursor.seq : 0,
      workspaceId,
    },
    {
      enabled: Boolean(workspaceId) && snapshotReady,
      onData(events) {
        const batch = events as AgentRuntimeChangeEvent[]
        if (batch.some((event) => event.op === 'insert' || event.op === 'delete')) {
          void envUtils.agent.sessionList.invalidate({ workspaceId })
        }
        syncedSeqRef.current = applyAgentRuntimeChangeEvents({
          events: batch,
          collectionUtils: collection.utils,
          collectionHas: (key) => collection.has(key),
          syncedSeq: syncedSeqRef.current,
        })
      },
    },
  )

  const live = useLiveQuery(() => collection, [collection])
  const records = (live.data ?? []).filter((record) => record.workspaceId === workspaceId)

  return { ...live, records }
}
