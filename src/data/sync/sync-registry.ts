import type { AnySyncedCollection } from './collection-factory'

const registeredAppSyncTables: AnySyncedCollection[] = []

export function registerAppSyncTable(collection: AnySyncedCollection): void {
  if (registeredAppSyncTables.some((entry) => entry.id === collection.id)) return
  registeredAppSyncTables.push(collection)
}

export function getAppSyncTables(): AnySyncedCollection[] {
  return registeredAppSyncTables
}

export const appSyncTables = registeredAppSyncTables
