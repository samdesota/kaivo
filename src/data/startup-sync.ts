import { getAppSyncTables } from './sync/sync-registry'
import { hydrateCollectionsFromLocalStore, persistCollectionsToLocalStore, readLocalSyncCursor, writeLocalSyncCursor } from './sync/local-store'
import { realtimeSyncClient } from './sync/realtime-client'
import type { SyncChangeEvent, SyncClient, SyncTableName } from './sync/types'
import type { AnySyncedCollection } from './sync/collection-factory'
import { clientLogger } from '../lib/client-logger'

const log = clientLogger.diagnostic('app-data')

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

  log.info('collections registered', { collections: collections.map((collection) => collection.id) })

  await hydrateCollectionsFromLocalStore(collections)

  const cursor = await readLocalSyncCursor(scope)
  const tables = collections.map((collection) => collection.table) as SyncTableName[]
  log.info('startup sync cursor', { scope, seq: cursor.seq, tables })
  if (cursor.seq === 0) {
    log.info('startup sync snapshot start', { tables })
    await applySnapshots(client, tables, collections)
  } else {
    log.info('startup sync resume start', { afterSeq: cursor.seq, tables })
    const result = await client.resume({ afterSeq: cursor.seq, tables })
    if (result.type === 'changes') {
      log.info('startup sync resume changes', { count: result.events.length })
      applyChangesToCollections(collections, result.events)
      const caughtUpSeq = result.events.reduce((seq, event) => Math.max(seq, event.seq), cursor.seq)
      for (const collection of collections) collection.markHydrated(caughtUpSeq)
    } else {
      log.info('startup sync resume stale; snapshot fallback', { tables })
      await applySnapshots(client, tables, collections)
    }
  }

  await persistCollectionsToLocalStore(collections)
  await writeLocalSyncCursor(scope, { seq: latestAppliedSeq(collections) })
  log.info('startup sync persisted', { seq: latestAppliedSeq(collections), counts: collectionCounts(collections) })

  if (!subscribe) return
  unsubscribeRealtime?.()
  log.info('startup sync subscribe', { afterSeq: latestAppliedSeq(collections), tables })
  const subscription = client.subscribe({
    afterSeq: latestAppliedSeq(collections),
    tables,
    onEvents(events) {
      log.debug('startup sync events', { count: events.length, maxSeq: events.reduce((seq, event) => Math.max(seq, event.seq), 0) })
      applyChangesToCollections(collections, events)
      void persistCollectionsToLocalStore(collections)
      void writeLocalSyncCursor(scope, { seq: latestAppliedSeq(collections) })
    },
  })
  unsubscribeRealtime = () => subscription.unsubscribe()
}

async function applySnapshots(client: SyncClient, tables: SyncTableName[], collections: AnySyncedCollection[]): Promise<void> {
  const snapshots = await client.snapshotMany(tables)
  for (const snapshot of snapshots) {
    for (const collection of collections) collection.applySnapshot(snapshot)
  }
}

export function applyChangesToCollections(collections: AnySyncedCollection[], events: SyncChangeEvent[]): void {
  for (const collection of collections) collection.applyChanges(events)
}

export function latestAppliedSeq(collections: AnySyncedCollection[]): number {
  return collections.reduce((seq, collection) => Math.max(seq, collection.getSeq()), 0)
}

function collectionCounts(collections: AnySyncedCollection[]): Record<string, number> {
  return Object.fromEntries(collections.map((collection) => [collection.id, collection.getRows().length]))
}
