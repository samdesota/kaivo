import { useMemo } from 'react'
import { createCollection, localOnlyCollectionOptions, useLiveQuery, type Collection } from '@tanstack/react-db'
import type { SyncChangeEvent, SyncSnapshot, SyncTableName } from './types'

export type SyncedCollectionConfig<Row extends object, Key extends string> = {
  table: SyncTableName
  id: string
  getKey(row: Row): Key
  normalize(raw: unknown): Row
}

export type SyncedCollection<Row extends object = Record<string, unknown>, Key extends string = string> = {
  table: SyncTableName
  id: string
  collection: Collection<Row, Key>
  getRows(): Row[]
  useRows(): Row[]
  applySnapshot(snapshot: SyncSnapshot): number
  applyChanges(events: SyncChangeEvent[]): number
  markHydrated(seq?: number): void
  isHydrated(): boolean
  getSeq(): number
}

export type AnySyncedCollection = SyncedCollection<any, string>

export function defineSyncedCollection<Row extends object, Key extends string>(config: SyncedCollectionConfig<Row, Key>): SyncedCollection<Row, Key> {
  let hydrated = false
  let syncedSeq = 0
  const rows = new Map<Key, Row>()
  const collection = createCollection(localOnlyCollectionOptions<Row, Key>({
    id: config.id,
    getKey: config.getKey,
  }) as never) as unknown as Collection<Row, Key>

  function upsert(row: Row) {
    const key = config.getKey(row)
    rows.set(key, row)
    if (collection.has(key)) {
      collection.update(key, (draft) => Object.assign(draft, row))
    } else {
      collection.insert(row)
    }
  }

  function remove(key: Key) {
    rows.delete(key)
    if (collection.has(key)) collection.delete(key)
  }

  const api: SyncedCollection<Row, Key> = {
    table: config.table,
    id: config.id,
    collection,
    getRows() {
      return [...rows.values()]
    },
    useRows() {
      const live = useLiveQuery(() => collection, [collection])
      return useMemo(() => (live.data ?? []) as Row[], [live.data])
    },
    applySnapshot(snapshot) {
      if (snapshot.table !== config.table) return syncedSeq
      const nextRows = snapshot.rows.map(config.normalize)
      const nextKeys = new Set(nextRows.map(config.getKey))
      for (const key of rows.keys()) {
        if (!nextKeys.has(key)) remove(key)
      }
      for (const row of nextRows) upsert(row)
      syncedSeq = Math.max(syncedSeq, snapshot.seq)
      hydrated = true
      return syncedSeq
    },
    applyChanges(events) {
      const ordered = events
        .filter((event) => event.table === config.table)
        .slice()
        .sort((a, b) => a.seq - b.seq)
      for (const event of ordered) {
        if (event.seq <= syncedSeq) continue
        if (event.op === 'delete') {
          remove(event.key as Key)
        } else if (event.row) {
          upsert(config.normalize(event.row))
        }
        syncedSeq = event.seq
      }
      if (ordered.length > 0) hydrated = true
      return syncedSeq
    },
    markHydrated(seq = syncedSeq) {
      syncedSeq = Math.max(syncedSeq, seq)
      hydrated = true
    },
    isHydrated() {
      return hydrated
    },
    getSeq() {
      return syncedSeq
    },
  }

  return api
}
