import type { AnySyncedCollection } from './collection-factory'
import type { SyncCursor } from './types'

const ROW_PREFIX = 'kaivo.sync.rows.'
const CURSOR_PREFIX = 'kaivo.sync.cursor.'

const memoryRows = new Map<string, unknown[]>()
const memoryCursors = new Map<string, SyncCursor>()

export async function readLocalRows<Row>(collectionId: string): Promise<Row[]> {
  if (typeof window === 'undefined' || !window.localStorage) return (memoryRows.get(collectionId) ?? []) as Row[]
  const raw = window.localStorage.getItem(`${ROW_PREFIX}${collectionId}`)
  return raw ? JSON.parse(raw) as Row[] : []
}

export async function writeLocalRows<Row>(collectionId: string, rows: Row[]): Promise<void> {
  if (typeof window === 'undefined' || !window.localStorage) {
    memoryRows.set(collectionId, rows)
    return
  }
  window.localStorage.setItem(`${ROW_PREFIX}${collectionId}`, JSON.stringify(rows))
}

export async function readLocalSyncCursor(scope: string): Promise<SyncCursor> {
  if (typeof window === 'undefined' || !window.localStorage) return memoryCursors.get(scope) ?? { seq: 0 }
  const raw = window.localStorage.getItem(`${CURSOR_PREFIX}${scope}`)
  return raw ? JSON.parse(raw) as SyncCursor : { seq: 0 }
}

export async function writeLocalSyncCursor(scope: string, cursor: SyncCursor): Promise<void> {
  if (typeof window === 'undefined' || !window.localStorage) {
    memoryCursors.set(scope, cursor)
    return
  }
  window.localStorage.setItem(`${CURSOR_PREFIX}${scope}`, JSON.stringify(cursor))
}

export async function hydrateCollectionsFromLocalStore(collections: AnySyncedCollection[]): Promise<void> {
  for (const collection of collections) {
    const rows = await readLocalRows(collection.id)
    collection.applySnapshot({ table: collection.table, rows: rows as Record<string, unknown>[], seq: collection.getSeq() })
  }
}

export async function persistCollectionsToLocalStore(collections: AnySyncedCollection[]): Promise<void> {
  for (const collection of collections) await writeLocalRows(collection.id, collection.getRows())
}

export function clearMemoryLocalStoreForTests(): void {
  memoryRows.clear()
  memoryCursors.clear()
}
