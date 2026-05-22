import { makeTrpcClient } from '../../trpc'
import type { SyncChangeEvent, SyncClient, SyncSnapshot, SyncTableName } from './types'

type AppSyncClient = {
  query(path: 'sync.snapshot', input: { table: string }): Promise<SyncSnapshot>
  subscription(path: 'sync.changes', input: { afterSeq: number; tables: string[] }, handlers: { onData(events: SyncChangeEvent[]): void; onError?(error: unknown): void }): { unsubscribe(): void }
}

export function createRealtimeSyncClient(client: AppSyncClient = makeTrpcClient() as unknown as AppSyncClient): SyncClient {
  return {
    async resume(input) {
      const events = await new Promise<SyncChangeEvent[]>((resolve, reject) => {
        let settled = false
        const sub = client.subscription(
          'sync.changes',
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
      })
      return { type: 'changes', events }
    },
    snapshot(table) {
      return client.query('sync.snapshot', { table })
    },
    async snapshotMany(tables) {
      return await Promise.all(tables.map((table) => this.snapshot(table)))
    },
    subscribe(input) {
      let resolveReady!: () => void
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve
      })
      let readyResolved = false
      const sub = client.subscription(
        'sync.changes',
        { afterSeq: input.afterSeq, tables: input.tables as SyncTableName[] },
        {
          onData(events) {
            if (!readyResolved) {
              readyResolved = true
              resolveReady()
            }
            if (events.length > 0) input.onEvents(events)
          },
          onError(error) {
            if (!readyResolved) {
              readyResolved = true
              resolveReady()
            }
            input.onError?.(error)
          },
        },
      )
      return { unsubscribe: () => sub.unsubscribe(), ready }
    },
  }
}

export const realtimeSyncClient = createRealtimeSyncClient()
