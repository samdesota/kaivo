import { useEffect, useMemo, useRef, useState } from 'react'
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

function logBookmarkSync(event: string, details: Record<string, unknown> = {}) {
  console.info(`[bookmarks-sync] ${JSON.stringify({ event, ...details })}`)
}

export async function upsertBookmark(input: BookmarkInput): Promise<BookmarkRecord> {
  const normalized = bookmarkInput(input)
  logBookmarkSync('upsert:start', { title: normalized.title, url: normalized.url, createdFrom: normalized.createdFrom })
  try {
    const saved = normalizeBookmarkRecord(await appTrpcMutation<RawBookmarkRecord>('bookmarks.upsert', normalized))
    logBookmarkSync('upsert:success', { id: saved.id, title: saved.title, url: saved.url, updatedAt: saved.updatedAt.getTime() })
    return saved
  } catch (error) {
    logBookmarkSync('upsert:error', { message: error instanceof Error ? error.message : String(error) })
    throw error
  }
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
  collectionHas?: (key: string) => boolean
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
        if (!input.collectionHas || input.collectionHas(event.key)) input.collectionUtils.writeDelete(event.key)
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
  const instanceIdRef = useRef(Math.random().toString(36).slice(2, 8))
  const [snapshotSeq, setSnapshotSeq] = useState<number | null>(null)
  const collection = useMemo(() => {
    logBookmarkSync('collection:create', { instanceId: instanceIdRef.current })
    const options = queryCollectionOptions({
      id: 'bookmarks',
      queryKey: ['sync', 'bookmarks'],
      queryClient,
      getKey: (record: BookmarkRecord) => record.id,
      queryFn: async () => {
        logBookmarkSync('snapshot:start', { instanceId: instanceIdRef.current, previousSeq: syncedSeqRef.current })
        try {
          const snapshot = await appTrpcQuery<BookmarksSnapshot>('sync.snapshot', { table: 'bookmarks' })
          syncedSeqRef.current = Math.max(syncedSeqRef.current, snapshot.seq)
          setSnapshotSeq(syncedSeqRef.current)
          const rows = snapshot.rows.map(normalizeBookmarkRecord)
          logBookmarkSync('snapshot:success', {
            instanceId: instanceIdRef.current,
            rowCount: rows.length,
            seq: snapshot.seq,
            firstId: rows[0]?.id ?? null,
            latestId: [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]?.id ?? null,
          })
          return rows
        } catch (error) {
          logBookmarkSync('snapshot:error', { instanceId: instanceIdRef.current, message: error instanceof Error ? error.message : String(error) })
          throw error
        }
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
    { afterSeq: snapshotSeq ?? 0, tables: ['bookmarks'] },
    {
      enabled: snapshotSeq !== null,
      onData(events) {
        const typedEvents = events as BookmarksChangeEvent[]
        logBookmarkSync('subscription:data', {
          instanceId: instanceIdRef.current,
          eventCount: typedEvents.length,
          currentSeq: syncedSeqRef.current,
          minSeq: typedEvents.length ? Math.min(...typedEvents.map((event) => event.seq)) : null,
          maxSeq: typedEvents.length ? Math.max(...typedEvents.map((event) => event.seq)) : null,
          ops: typedEvents.reduce<Record<string, number>>((acc, event) => {
            acc[event.op] = (acc[event.op] ?? 0) + 1
            return acc
          }, {}),
        })
        syncedSeqRef.current = applyBookmarkChangeEvents({
          events: typedEvents,
          collectionUtils: collection.utils,
          collectionHas: (key) => collection.has(key),
          syncedSeq: syncedSeqRef.current,
        })
        logBookmarkSync('subscription:applied', { instanceId: instanceIdRef.current, nextSeq: syncedSeqRef.current })
      },
      onError(error) {
        logBookmarkSync('subscription:error', { instanceId: instanceIdRef.current, message: error instanceof Error ? error.message : String(error) })
      },
    },
  )

  const live = useLiveQuery(() => collection, [collection])
  const bookmarks = validBookmarks(live.data ?? [])
  const bookmarksSignature = bookmarks
    .map((bookmark) => `${bookmark.id}:${bookmark.updatedAt.getTime()}`)
    .join('|')

  useEffect(() => {
    if (snapshotSeq === null) return
    logBookmarkSync('subscription:mounted', { instanceId: instanceIdRef.current, afterSeq: snapshotSeq })
  }, [snapshotSeq])

  useEffect(() => {
    logBookmarkSync('live:update', {
      instanceId: instanceIdRef.current,
      rawCount: live.data?.length ?? 0,
      validCount: bookmarks.length,
      syncedSeq: syncedSeqRef.current,
      latest: bookmarks.slice(0, 3).map((bookmark) => ({ id: bookmark.id, title: bookmark.title, url: bookmark.url, updatedAt: bookmark.updatedAt.getTime() })),
    })
  }, [bookmarksSignature, live.data?.length])

  return {
    ...live,
    collection,
    bookmarks,
  }
}
