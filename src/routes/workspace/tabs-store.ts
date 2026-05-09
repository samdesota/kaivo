import { useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createCollection, useLiveQuery, type Collection } from '@tanstack/react-db'
import { queryCollectionOptions, type QueryCollectionUtils } from '@tanstack/query-db-collection'
import { appTrpcMutation, appTrpcQuery } from '../../lib/trpc-plain'
import { trpc } from '../../trpc'
import { workspaceTabKey, type WorkspaceTab } from '../../../shared/workspace-pane'

export type WorkspaceTabRecord = {
  workspaceId: string
  id: string
  type: WorkspaceTab['type']
  title: string
  position: number
  envId: string | null
  shellId: string | null
  path: string | null
  sessionId: string | null
  port: number | null
  url: string | null
  browserTabId: string | null
  updatedAt: Date
}

type WorkspaceTabsCollection = Collection<WorkspaceTabRecord, string> & {
  utils: QueryCollectionUtils<WorkspaceTabRecord, string>
}

type WorkspaceTabsSnapshot = {
  table: 'workspace_tabs'
  rows: Array<Omit<WorkspaceTabRecord, 'updatedAt'> & { updatedAt: Date | number | string }>
  seq: number
}

type WorkspaceTabsChangeEvent = {
  seq: number
  table: 'workspace_tabs'
  op: 'insert' | 'update' | 'delete'
  key: string
  row: (Omit<WorkspaceTabRecord, 'updatedAt'> & { updatedAt: Date | number | string }) | null
}

function workspaceTabRecordKey(record: Pick<WorkspaceTabRecord, 'workspaceId' | 'id'>): string {
  return JSON.stringify({ workspace_id: record.workspaceId, id: record.id })
}

function normalizeWorkspaceTabRecord(record: Omit<WorkspaceTabRecord, 'updatedAt'> & { updatedAt: Date | number | string }): WorkspaceTabRecord {
  return {
    ...record,
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt : new Date(record.updatedAt),
  }
}

function workspaceTabIdFromKey(key: unknown): string {
  if (typeof key !== 'string') return String(key)
  try {
    const parsed = JSON.parse(key) as { id?: unknown }
    if (typeof parsed.id === 'string') return parsed.id
  } catch {
    // Fall through for legacy/plain keys.
  }
  return key
}

export function recordToWorkspaceTab(record: WorkspaceTabRecord): WorkspaceTab | null {
  if (record.type === 'shell' && record.envId && record.shellId) {
    return { id: record.id, type: 'shell', envId: record.envId, shellId: record.shellId, title: record.title }
  }
  if (record.type === 'file' && record.envId && record.path) {
    return { id: record.id, type: 'file', envId: record.envId, path: record.path, sessionId: record.sessionId ?? undefined, title: record.title }
  }
  if (record.type === 'preview' && record.envId && record.port !== null) {
    return { id: record.id, type: 'preview', envId: record.envId, port: record.port, title: record.title }
  }
  if (record.type === 'browser' && record.url) {
    return { id: record.id, type: 'browser', url: record.url, browserTabId: record.browserTabId ?? undefined, title: record.title }
  }
  return null
}

function workspaceTabToRecord(workspaceId: string, tab: WorkspaceTab, position: number): WorkspaceTabRecord {
  return {
    workspaceId,
    id: tab.id,
    type: tab.type,
    title: tab.title,
    position,
    envId: 'envId' in tab ? tab.envId : null,
    shellId: tab.type === 'shell' ? tab.shellId : null,
    path: tab.type === 'file' ? tab.path : null,
    sessionId: tab.type === 'file' ? (tab.sessionId ?? null) : null,
    port: tab.type === 'preview' ? tab.port : null,
    url: tab.type === 'browser' ? tab.url : null,
    browserTabId: tab.type === 'browser' ? (tab.browserTabId ?? null) : null,
    updatedAt: new Date(),
  }
}

function recordToMutationTab(record: WorkspaceTabRecord): WorkspaceTab | null {
  return recordToWorkspaceTab(record)
}

export function compareWorkspaceTabRecords(a: WorkspaceTabRecord, b: WorkspaceTabRecord): number {
  return a.position - b.position || a.id.localeCompare(b.id)
}

export function useWorkspaceTabsStore(workspaceId: string) {
  const queryClient = useQueryClient()
  const syncedSeqRef = useRef(0)
  const collection = useMemo(() => {
    const options = queryCollectionOptions({
      id: `workspace-tabs:${workspaceId}`,
      queryKey: ['sync', 'workspace_tabs'],
      queryClient,
      getKey: workspaceTabRecordKey,
      queryFn: async () => {
        const snapshot = await appTrpcQuery<WorkspaceTabsSnapshot>('sync.snapshot', { table: 'workspace_tabs' })
        syncedSeqRef.current = Math.max(syncedSeqRef.current, snapshot.seq)
        return snapshot.rows.map(normalizeWorkspaceTabRecord)
      },
      onInsert: async ({ transaction }: { transaction: { mutations: Array<{ modified: unknown }> } }) => {
        for (const mutation of transaction.mutations) {
          const record = mutation.modified as WorkspaceTabRecord
          const tab = recordToMutationTab(record)
          if (!tab) continue
          await appTrpcMutation('workspace.upsertTab', { workspaceId: record.workspaceId, tab, position: record.position })
        }
      },
      onUpdate: async ({ transaction }: { transaction: { mutations: Array<{ modified: unknown }> } }) => {
        for (const mutation of transaction.mutations) {
          const record = mutation.modified as WorkspaceTabRecord
          const tab = recordToMutationTab(record)
          if (!tab) continue
          await appTrpcMutation('workspace.upsertTab', { workspaceId: record.workspaceId, tab, position: record.position })
        }
      },
      onDelete: async ({ transaction }: { transaction: { mutations: Array<{ key: unknown }> } }) => {
        for (const mutation of transaction.mutations) {
          await appTrpcMutation('workspace.deleteTab', { workspaceId, tabId: workspaceTabIdFromKey(mutation.key) })
        }
      },
    })
    return createCollection(options as never) as unknown as WorkspaceTabsCollection
  }, [queryClient, workspaceId])

  trpc.sync.changes.useSubscription(
    { afterSeq: syncedSeqRef.current, tables: ['workspace_tabs'] },
    {
      onData(events) {
        const batch = events as WorkspaceTabsChangeEvent[]
        const deduped = new Map<string, WorkspaceTabsChangeEvent>()
        for (const event of batch) {
          if (event.seq <= syncedSeqRef.current) continue
          deduped.set(event.key, event)
        }
        collection.utils.writeBatch(() => {
          for (const event of deduped.values()) {
            if (event.op === 'delete') {
              collection.utils.writeDelete(event.key)
            } else if (event.row) {
              collection.utils.writeUpsert(normalizeWorkspaceTabRecord(event.row))
            }
            syncedSeqRef.current = event.seq
          }
        })
      },
    },
  )

  const live = useLiveQuery(() => collection, [collection])
  const records = (live.data ?? []).filter((record) => record.workspaceId === workspaceId).slice().sort(compareWorkspaceTabRecords)
  const tabs = records.map(recordToWorkspaceTab).filter((tab): tab is WorkspaceTab => Boolean(tab))

  return {
    ...live,
    records,
    tabs,
    openTab(tab: WorkspaceTab, activate = true): WorkspaceTab {
      const existing = tabs.find((current) => workspaceTabKey(current) === workspaceTabKey(tab))
      if (existing) return existing
      const position = Array.from(collection.values())
        .filter((record) => record.workspaceId === workspaceId)
        .reduce((max, record) => Math.max(max, record.position), -1) + 1
      collection.insert(workspaceTabToRecord(workspaceId, tab, position))
      return tab
    },
    closeTab(tabId: string) {
      const record = records.find((tab) => tab.id === tabId)
      if (record) collection.delete(workspaceTabRecordKey(record))
    },
    setBrowserTabId(tabId: string, browserTabId: string) {
      const record = records.find((tab) => tab.id === tabId)
      if (!record) return
      collection.update(workspaceTabRecordKey(record), (draft) => {
        draft.browserTabId = browserTabId
      })
    },
    setTabUrl(tabId: string, url: string) {
      const record = records.find((tab) => tab.id === tabId)
      if (!record || record.type !== 'browser' || record.url === url) return
      collection.update(workspaceTabRecordKey(record), (draft) => {
        draft.url = url
      })
    },
    setTabTitle(tabId: string, title: string) {
      const record = records.find((tab) => tab.id === tabId)
      if (!record) return
      collection.update(workspaceTabRecordKey(record), (draft) => {
        draft.title = title
      })
    },
  }
}
