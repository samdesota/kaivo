import { useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { createCollection, useLiveQuery, type Collection } from '@tanstack/react-db'
import { queryCollectionOptions, type QueryCollectionUtils } from '@tanstack/query-db-collection'
import { bookmarkOriginForUrl, normalizeBookmarkUrl } from '../../lib/browser-navigation'
import { appTrpcMutation, appTrpcQuery } from '../../lib/trpc-plain'
import { trpc } from '../../trpc'

export { bookmarkOriginForUrl, normalizeBookmarkUrl } from '../../lib/browser-navigation'

export type BookmarkRecord = {
  id: string
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

type BookmarksCollection = Collection<BookmarkRecord, string> & {
  utils: QueryCollectionUtils<BookmarkRecord, string>
}

export type RawBookmarkRecord = Omit<BookmarkRecord, 'createdAt' | 'updatedAt'> & { createdAt: Date | number | string; updatedAt: Date | number | string }

type BookmarksSnapshot = {
  table: 'bookmarks'
  rows: RawBookmarkRecord[]
  seq: number
}

export type BookmarksChangeEvent = {
  seq: number
  table: 'bookmarks'
  op: 'insert' | 'update' | 'delete'
  key: string
  row: RawBookmarkRecord | null
}

export function bookmarkInput(input: BookmarkInput): BookmarkInput {
  const normalizedUrl = normalizeBookmarkUrl(input.url)
  return {
    title: input.title.trim(),
    url: normalizedUrl,
    faviconDataUrl: input.faviconDataUrl ?? null,
    faviconUrl: input.faviconUrl ?? null,
    createdFrom: input.createdFrom,
  }
}

export async function upsertBookmark(input: BookmarkInput): Promise<BookmarkRecord> {
  return normalizeBookmarkRecord(await appTrpcMutation<RawBookmarkRecord>('bookmarks.upsert', bookmarkInput(input)))
}

export async function deleteBookmark(id: string): Promise<void> {
  await appTrpcMutation('bookmarks.delete', { id })
}

export function normalizeBookmarkRecord(record: RawBookmarkRecord): BookmarkRecord {
  const normalizedUrl = record.normalizedUrl || normalizeBookmarkUrl(record.url)
  return {
    ...record,
    url: record.url || normalizedUrl,
    normalizedUrl,
    origin: record.origin ?? bookmarkOriginForUrl(normalizedUrl),
    faviconDataUrl: record.faviconDataUrl ?? null,
    faviconUrl: record.faviconUrl ?? null,
    createdAt: record.createdAt instanceof Date ? record.createdAt : new Date(record.createdAt),
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt : new Date(record.updatedAt),
  }
}

export function validBookmarks(records: BookmarkRecord[]): BookmarkRecord[] {
  return records.filter((bookmark) => Boolean(
    typeof bookmark.id === 'string'
      && typeof bookmark.title === 'string'
      && typeof bookmark.url === 'string'
      && typeof bookmark.normalizedUrl === 'string'
      && bookmark.id
      && bookmark.title.trim()
      && bookmark.url.trim()
      && bookmark.normalizedUrl.trim(),
  ))
}

export type BookmarkCollectionUtils = QueryCollectionUtils<BookmarkRecord, string>

export function applyBookmarkChangeEvents(input: {
  events: BookmarksChangeEvent[]
  collectionUtils: BookmarkCollectionUtils
  syncedSeq: number
}): number {
  let nextSeq = input.syncedSeq
  const deduped = new Map<string, BookmarksChangeEvent>()
  for (const event of input.events) {
    if (event.seq <= nextSeq) continue
    deduped.set(event.key, event)
  }
  input.collectionUtils.writeBatch(() => {
    for (const event of deduped.values()) {
      if (event.op === 'delete') {
        input.collectionUtils.writeDelete(event.key)
      } else if (event.row) {
        input.collectionUtils.writeUpsert(normalizeBookmarkRecord(event.row))
      }
      nextSeq = Math.max(nextSeq, event.seq)
    }
  })
  return nextSeq
}

export function useBookmarksStore() {
  const queryClient = useQueryClient()
  const syncedSeqRef = useRef(0)
  const collection = useMemo(() => {
    const options = queryCollectionOptions({
      id: 'bookmarks',
      queryKey: ['sync', 'bookmarks'],
      queryClient,
      getKey: (record: BookmarkRecord) => record.id,
      queryFn: async () => {
        const snapshot = await appTrpcQuery<BookmarksSnapshot>('sync.snapshot', { table: 'bookmarks' })
        syncedSeqRef.current = Math.max(syncedSeqRef.current, snapshot.seq)
        return snapshot.rows.map(normalizeBookmarkRecord)
      },
      onInsert: async ({ transaction }: { transaction: { mutations: Array<{ modified: unknown }> } }) => {
        for (const mutation of transaction.mutations) await appTrpcMutation('bookmarks.upsert', bookmarkInput(mutation.modified as BookmarkRecord))
      },
      onUpdate: async ({ transaction }: { transaction: { mutations: Array<{ modified: unknown }> } }) => {
        for (const mutation of transaction.mutations) await appTrpcMutation('bookmarks.upsert', bookmarkInput(mutation.modified as BookmarkRecord))
      },
      onDelete: async ({ transaction }: { transaction: { mutations: Array<{ key: unknown }> } }) => {
        for (const mutation of transaction.mutations) await appTrpcMutation('bookmarks.delete', { id: String(mutation.key) })
      },
    })
    return createCollection(options as never) as unknown as BookmarksCollection
  }, [queryClient])

  trpc.sync.changes.useSubscription(
    { afterSeq: syncedSeqRef.current, tables: ['bookmarks'] },
    {
      onData(events) {
        syncedSeqRef.current = applyBookmarkChangeEvents({
          events: events as BookmarksChangeEvent[],
          collectionUtils: collection.utils,
          syncedSeq: syncedSeqRef.current,
        })
      },
    },
  )

  const live = useLiveQuery(() => collection, [collection])
  const bookmarks = validBookmarks(live.data ?? [])

  return {
    ...live,
    collection,
    bookmarks,
  }
}
