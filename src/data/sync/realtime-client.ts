import { makeTrpcClient } from '../../trpc'
import type { SyncChangeEvent, SyncClient, SyncSnapshot, SyncTableName } from './types'

type AppSyncClient = {
  sync: {
    snapshot: { query(input: { table: string }): Promise<SyncSnapshot> }
    changes: { subscribe(input: { afterSeq: number; tables: string[] }, handlers: { onData(events: SyncChangeEvent[]): void; onError?(error: unknown): void }): { unsubscribe(): void } }
  }
}

export function createRealtimeSyncClient(client: AppSyncClient = makeTrpcClient() as unknown as AppSyncClient): SyncClient {
  return {
    async resume(input) {
      const events = await new Promise<SyncChangeEvent[]>((resolve, reject) => {
        let settled = false
        const sub = client.sync.changes.subscribe(
          { afterSeq: input.afterSeq, tables: input.tables },
          {
            onData(events) {
              if (settled) return
              settled = true
              sub.unsubscribe()
              resolve(events)
            },
            onError(error) {
              if (settled) return
              settled = true
              sub.unsubscribe()
              reject(error)
            },
          },
        )
        queueMicrotask(() => {
          if (settled) return
          settled = true
          sub.unsubscribe()
          resolve([])
        })
      })
      return { type: 'changes', events }
    },
    snapshot(table) {
      return client.sync.snapshot.query({ table })
    },
    async snapshotMany(tables) {
      return await Promise.all(tables.map((table) => this.snapshot(table)))
    },
    subscribe(input) {
      const sub = client.sync.changes.subscribe(
        { afterSeq: input.afterSeq, tables: input.tables as SyncTableName[] },
        { onData: input.onEvents, onError: input.onError },
      )
      return () => sub.unsubscribe()
    },
  }
}

export const realtimeSyncClient = createRealtimeSyncClient()
