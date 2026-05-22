import { getAppSyncTables } from './sync/sync-registry'
import { hydrateCollectionsFromLocalStore, persistCollectionsToLocalStore, readLocalSyncCursor, writeLocalSyncCursor } from './sync/local-store'
import { realtimeSyncClient } from './sync/realtime-client'
import type { SyncChangeEvent, SyncClient } from './sync/types'
import type { AnySyncedCollection } from './sync/collection-factory'

export type StartupSyncOptions = {
  collections?: AnySyncedCollection[]
  client?: SyncClient
  scope?: string
  subscribe?: boolean
}

let startupSyncPromise: Promise<void> | null = null
let unsubscribeRealtime: (() => void) | null = null

export function startAppDataSync(options: StartupSyncOptions = {}): Promise<void> {
  if (!startupSyncPromise) startupSyncPromise = runStartupSync(options)
  return startupSyncPromise
}

export function resetAppDataSync(): void {
  unsubscribeRealtime?.()
  unsubscribeRealtime = null
  startupSyncPromise = null
}

export const resetAppDataSyncForTests = resetAppDataSync

async function runStartupSync(options: StartupSyncOptions): Promise<void> {
  const collections = options.collections ?? getAppSyncTables()
  const client = options.client ?? realtimeSyncClient
  const scope = options.scope ?? 'app'
  const subscribe = options.subscribe ?? true
  if (collections.length === 0) return

  await hydrateCollectionsFromLocalStore(collections)

  const cursor = await readLocalSyncCursor(scope)
  const tables = collections.map((collection) => collection.table)
  const result = await client.resume({ afterSeq: cursor.seq, tables })

  if (result.type === 'changes') {
    applyChangesToCollections(collections, result.events)
  } else {
    const snapshots = await client.snapshotMany(tables)
    for (const snapshot of snapshots) {
      for (const collection of collections) collection.applySnapshot(snapshot)
    }
  }

  await persistCollectionsToLocalStore(collections)
  await writeLocalSyncCursor(scope, { seq: latestAppliedSeq(collections) })

  if (!subscribe) return
  unsubscribeRealtime?.()
  unsubscribeRealtime = client.subscribe({
    afterSeq: latestAppliedSeq(collections),
    tables,
    onEvents(events) {
      applyChangesToCollections(collections, events)
      void persistCollectionsToLocalStore(collections)
      void writeLocalSyncCursor(scope, { seq: latestAppliedSeq(collections) })
    },
  })
}

export function applyChangesToCollections(collections: AnySyncedCollection[], events: SyncChangeEvent[]): void {
  for (const collection of collections) collection.applyChanges(events)
}

export function latestAppliedSeq(collections: AnySyncedCollection[]): number {
  return collections.reduce((seq, collection) => Math.max(seq, collection.getSeq()), 0)
}
