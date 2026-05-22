import { useSyncExternalStore } from 'react'
import { createCollection, localOnlyCollectionOptions, type Collection } from '@tanstack/react-db'
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
  let version = 0
  let rowsSnapshot: Row[] = []
  const rows = new Map<Key, Row>()
  const listeners = new Set<() => void>()
  const collection = createCollection(localOnlyCollectionOptions<Row, Key>({
    id: config.id,
    getKey: config.getKey,
  }) as never) as unknown as Collection<Row, Key>

  function upsert(row: Row) {
    const key = config.getKey(row)
    rows.set(key, row)
  }

  function remove(key: Key) {
    rows.delete(key)
  }

  function subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  function getVersionSnapshot() {
    return rowsSnapshot
  }

  function emitChange() {
    version += 1
    rowsSnapshot = [...rows.values()]
    for (const listener of listeners) listener()
  }

  const api: SyncedCollection<Row, Key> = {
    table: config.table,
    id: config.id,
    collection,
    getRows() {
      return [...rows.values()]
    },
    useRows() {
      return useSyncExternalStore(subscribe, getVersionSnapshot, getVersionSnapshot)
    },
    applySnapshot(snapshot) {
      if (snapshot.table !== config.table) return syncedSeq
      const nextRows = snapshot.rows.map(config.normalize)
      const nextKeys = new Set(nextRows.map(config.getKey))
      let changed = rows.size !== nextRows.length
      for (const key of rows.keys()) {
        if (!nextKeys.has(key)) {
          remove(key)
          changed = true
        }
      }
      for (const row of nextRows) {
        const key = config.getKey(row)
        if (!shallowEqualRow(rows.get(key), row)) changed = true
        upsert(row)
      }
      const nextSeq = Math.max(syncedSeq, snapshot.seq)
      if (nextSeq !== syncedSeq) changed = true
      syncedSeq = nextSeq
      hydrated = true
      if (changed) emitChange()
      return syncedSeq
    },
    applyChanges(events) {
      const ordered = events
        .filter((event) => event.table === config.table)
        .slice()
        .sort((a, b) => a.seq - b.seq)
      let changed = false
      for (const event of ordered) {
        if (event.seq <= syncedSeq) continue
        if (event.op === 'delete') {
          remove(event.key as Key)
        } else if (event.row) {
          upsert(config.normalize(event.row))
        }
        syncedSeq = event.seq
        changed = true
      }
      if (ordered.length > 0) hydrated = true
      if (changed) emitChange()
      return syncedSeq
    },
    markHydrated(seq = syncedSeq) {
      const nextSeq = Math.max(syncedSeq, seq)
      const changed = !hydrated || nextSeq !== syncedSeq
      syncedSeq = nextSeq
      hydrated = true
      if (changed) emitChange()
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

function shallowEqualRow<Row extends object>(left: Row | undefined, right: Row): boolean {
  if (!left) return false
  const leftKeys = Object.keys(left) as Array<keyof Row>
  const rightKeys = Object.keys(right) as Array<keyof Row>
  if (leftKeys.length !== rightKeys.length) return false
  return rightKeys.every((key) => Object.is(left[key], right[key]))
}
