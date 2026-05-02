import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createCollection, useLiveQuery, type Collection } from '@tanstack/react-db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { trpc } from '../../trpc'
import { type WorkspaceTab, workspaceTabKey } from './tab-state'

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
  const trpcUtils = trpc.useUtils()
  const collection = useMemo(() => {
    const options = queryCollectionOptions({
      id: `workspace-tabs:${workspaceId}`,
      queryKey: ['workspace-tabs', workspaceId],
      queryClient,
      getKey: (tab: WorkspaceTabRecord) => tab.id,
      queryFn: async () => await trpcUtils.client.workspace.listTabs.query({ workspaceId }),
      onInsert: async ({ transaction }: { transaction: { mutations: Array<{ modified: unknown }> } }) => {
        for (const mutation of transaction.mutations) {
          const record = mutation.modified as WorkspaceTabRecord
          const tab = recordToMutationTab(record)
          if (!tab) continue
          await trpcUtils.client.workspace.upsertTab.mutate({ workspaceId: record.workspaceId, tab, position: record.position })
        }
      },
      onUpdate: async ({ transaction }: { transaction: { mutations: Array<{ modified: unknown }> } }) => {
        for (const mutation of transaction.mutations) {
          const record = mutation.modified as WorkspaceTabRecord
          const tab = recordToMutationTab(record)
          if (!tab) continue
          await trpcUtils.client.workspace.upsertTab.mutate({ workspaceId: record.workspaceId, tab, position: record.position })
        }
      },
      onDelete: async ({ transaction }: { transaction: { mutations: Array<{ key: unknown }> } }) => {
        for (const mutation of transaction.mutations) {
          await trpcUtils.client.workspace.deleteTab.mutate({ workspaceId, tabId: String(mutation.key) })
        }
      },
    })
    return createCollection(options as never) as unknown as Collection<WorkspaceTabRecord, string>
  }, [queryClient, trpcUtils.client, workspaceId])

  const live = useLiveQuery(() => collection, [collection])
  const records = (live.data ?? []).slice().sort(compareWorkspaceTabRecords)
  const tabs = records.map(recordToWorkspaceTab).filter((tab): tab is WorkspaceTab => Boolean(tab))

  return {
    ...live,
    records,
    tabs,
    openTab(tab: WorkspaceTab, activate = true): WorkspaceTab {
      const existing = tabs.find((current) => workspaceTabKey(current) === workspaceTabKey(tab))
      if (existing) return existing
      const position = Array.from(collection.values()).reduce((max, record) => Math.max(max, record.position), -1) + 1
      collection.insert(workspaceTabToRecord(workspaceId, tab, position))
      return tab
    },
    closeTab(tabId: string) {
      if (collection.has(tabId)) collection.delete(tabId)
    },
    setBrowserTabId(tabId: string, browserTabId: string) {
      if (!collection.has(tabId)) return
      collection.update(tabId, (draft) => {
        draft.browserTabId = browserTabId
      })
    },
    setTabTitle(tabId: string, title: string) {
      if (!collection.has(tabId)) return
      collection.update(tabId, (draft) => {
        draft.title = title
      })
    },
  }
}
