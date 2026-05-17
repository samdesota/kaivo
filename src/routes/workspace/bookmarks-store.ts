import { useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createCollection, useLiveQuery, type Collection } from '@tanstack/react-db'
import { queryCollectionOptions, type QueryCollectionUtils } from '@tanstack/query-db-collection'
import { bookmarkOriginForUrl, normalizeBookmarkUrl } from '../../lib/browser-navigation'
import { appTrpcMutation, appTrpcQuery } from '../../lib/trpc-plain'
import { trpc } from '../../trpc'
import {
  applyWorkspaceResourceChangeEvents,
  normalizeWorkspaceResourceRecord,
  type RawWorkspaceResourceRecord,
  type WorkspaceResourceRecord,
  type WorkspaceResourcesChangeEvent,
} from './resources-store'

export { bookmarkOriginForUrl, normalizeBookmarkUrl } from '../../lib/browser-navigation'

export type BookmarkRecord = {
  id: string
  workspaceId: string
  title: string
  url: string
  normalizedUrl: string
  origin: string | null
  faviconDataUrl?: string | null
  faviconUrl?: string | null
  createdAt: Date
  updatedAt: Date
}

export type BookmarkInput = {
  title: string
  url: string
  faviconDataUrl?: string | null
  faviconUrl?: string | null
  createdFrom?: 'browser-pane' | 'universal-menu' | 'migration'
}

type WorkspaceResourcesCollection = Collection<WorkspaceResourceRecord, string> & {
  utils: QueryCollectionUtils<WorkspaceResourceRecord, string>
}

type WorkspaceResourcesSnapshot = {
  table: 'workspace_resources'
  rows: RawWorkspaceResourceRecord[]
  seq: number
}

export function bookmarkResourceKeyForUrl(url: string): string {
  return `bookmark:${normalizeBookmarkUrl(url)}`
}

export function bookmarkResourceData(input: BookmarkInput): Record<string, unknown> {
  const normalizedUrl = normalizeBookmarkUrl(input.url)
  return {
    title: input.title.trim(),
    url: normalizedUrl,
    normalizedUrl,
    origin: bookmarkOriginForUrl(normalizedUrl),
    faviconDataUrl: input.faviconDataUrl ?? null,
    faviconUrl: input.faviconUrl ?? null,
    createdFrom: input.createdFrom,
  }
}

export function bookmarkResourceInput(input: BookmarkInput): Pick<WorkspaceResourceRecord, 'type' | 'resourceKey' | 'shared' | 'data'> {
  const data = bookmarkResourceData(input)
  return {
    type: 'bookmark',
    resourceKey: `bookmark:${data.normalizedUrl}`,
    shared: true,
    data,
  }
}

export async function upsertWorkspaceBookmark(workspaceId: string, input: BookmarkInput): Promise<WorkspaceResourceRecord> {
  return await appTrpcMutation<WorkspaceResourceRecord>('workspace.upsertResource', {
    workspaceId,
    resource: bookmarkResourceInput(input),
  })
}

export async function deleteWorkspaceBookmark(id: string): Promise<void> {
  await appTrpcMutation('workspace.deleteResource', { id })
}

export function bookmarkFromResource(resource: WorkspaceResourceRecord): BookmarkRecord | null {
  if (resource.type !== 'bookmark') return null
  const data = resource.data
  const title = typeof data.title === 'string' ? data.title.trim() : ''
  const url = typeof data.url === 'string' ? data.url.trim() : ''
  const normalizedUrl = typeof data.normalizedUrl === 'string' ? data.normalizedUrl.trim() : normalizeBookmarkUrl(url)
  if (!title || !url || !normalizedUrl) return null
  return {
    id: resource.id,
    workspaceId: resource.workspaceId,
    title,
    url,
    normalizedUrl,
    origin: typeof data.origin === 'string' ? data.origin : bookmarkOriginForUrl(normalizedUrl),
    faviconDataUrl: typeof data.faviconDataUrl === 'string' ? data.faviconDataUrl : null,
    faviconUrl: typeof data.faviconUrl === 'string' ? data.faviconUrl : null,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
  }
}

export function bookmarksFromResources(resources: WorkspaceResourceRecord[], workspaceId?: string): BookmarkRecord[] {
  return resources
    .filter((resource) => !workspaceId || resource.workspaceId === workspaceId)
    .map(bookmarkFromResource)
    .filter((bookmark): bookmark is BookmarkRecord => bookmark !== null)
}

export function useWorkspaceBookmarksStore(workspaceId?: string) {
  const queryClient = useQueryClient()
  const syncedSeqRef = useRef(0)
  const collection = useMemo(() => {
    const options = queryCollectionOptions({
      id: 'workspace-bookmarks-resources',
      queryKey: ['sync', 'workspace_resources', 'bookmarks'],
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
        syncedSeqRef.current = applyWorkspaceResourceChangeEvents({
          events: events as WorkspaceResourcesChangeEvent[],
          collectionUtils: collection.utils,
          syncedSeq: syncedSeqRef.current,
        })
      },
    },
  )

  const live = useLiveQuery(() => collection, [collection])
  const records = (live.data ?? []).filter((record) => !workspaceId || record.workspaceId === workspaceId)
  const bookmarks = bookmarksFromResources(records)

  return {
    ...live,
    collection,
    records,
    bookmarks,
  }
}
