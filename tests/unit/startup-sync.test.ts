import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineSyncedCollection } from '../../src/data/sync/collection-factory'
import { clearMemoryLocalStoreForTests, writeLocalRows, writeLocalSyncCursor } from '../../src/data/sync/local-store'
import { resetAppDataSyncForTests, startAppDataSync } from '../../src/data/startup-sync'
import type { SyncClient } from '../../src/data/sync/types'

type TestRow = { id: string; title: string }

function collection(id = `test-${crypto.randomUUID()}`) {
  return defineSyncedCollection<TestRow, string>({
    id,
    table: 'workspaces',
    getKey: (row) => row.id,
    normalize: (raw) => raw as TestRow,
  })
}

afterEach(() => {
  resetAppDataSyncForTests()
  clearMemoryLocalStoreForTests()
})

describe('defineSyncedCollection', () => {
  it('applies insert/update/delete events in sequence order and ignores duplicate or old events', () => {
    const synced = collection()

    const seq = synced.applyChanges([
      { seq: 2, table: 'workspaces', op: 'update' as const, key: 'workspace-1', row: { id: 'workspace-1', title: 'Updated' } },
      { seq: 1, table: 'workspaces', op: 'insert' as const, key: 'workspace-1', row: { id: 'workspace-1', title: 'Initial' } },
      { seq: 1, table: 'workspaces', op: 'update' as const, key: 'workspace-1', row: { id: 'workspace-1', title: 'Old duplicate' } },
      { seq: 3, table: 'workspaces', op: 'delete' as const, key: 'workspace-1', row: null },
      { seq: 2, table: 'workspaces', op: 'insert' as const, key: 'workspace-2', row: { id: 'workspace-2', title: 'Old after delete' } },
    ])

    expect(seq).toBe(3)
    expect(synced.getRows()).toEqual([])
    expect(synced.getSeq()).toBe(3)
  })
})

describe('startup sync', () => {
  it('hydrates local rows first, applies missed changes, and records the latest cursor', async () => {
    const synced = collection('startup-sync-local')
    await writeLocalRows('startup-sync-local', [{ id: 'workspace-1', title: 'Local' }])
    await writeLocalSyncCursor('app-test', { seq: 4 })
    const subscribe = vi.fn(() => ({ unsubscribe: vi.fn(), ready: Promise.resolve() }))
    const client: SyncClient = {
      resume: vi.fn(async () => ({
        type: 'changes' as const,
        events: [{ seq: 5, table: 'workspaces', op: 'update' as const, key: 'workspace-1', row: { id: 'workspace-1', title: 'Remote' } }],
      })),
      snapshot: vi.fn(),
      snapshotMany: vi.fn(),
      subscribe,
    }

    await startAppDataSync({ collections: [synced], client, scope: 'app-test' })

    expect(client.resume).toHaveBeenCalledWith({ afterSeq: 4, tables: ['workspaces'] })
    expect(synced.getRows()).toEqual([{ id: 'workspace-1', title: 'Remote' }])
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 5, tables: ['workspaces'] }))
  })

  it('falls back to snapshots when resume reports stale local state', async () => {
    const synced = collection('startup-sync-stale')
    await writeLocalRows('startup-sync-stale', [{ id: 'workspace-local', title: 'Local' }])
    await writeLocalSyncCursor('app-stale', { seq: 9 })
    const client: SyncClient = {
      resume: vi.fn(async () => ({ type: 'stale' as const })),
      snapshot: vi.fn(),
      snapshotMany: vi.fn(async () => [
        { table: 'workspaces', seq: 12, rows: [{ id: 'workspace-server', title: 'Server' }] },
      ]),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn(), ready: Promise.resolve() })),
    }

    await startAppDataSync({ collections: [synced], client, scope: 'app-stale', subscribe: false })

    expect(client.snapshotMany).toHaveBeenCalledWith(['workspaces'])
    expect(synced.getRows()).toEqual([{ id: 'workspace-server', title: 'Server' }])
    expect(synced.getSeq()).toBe(12)
  })

  it('uses snapshots instead of replaying all changes when there is no durable cursor', async () => {
    const synced = collection('startup-sync-cold-start')
    const client: SyncClient = {
      resume: vi.fn(),
      snapshot: vi.fn(),
      snapshotMany: vi.fn(async () => [
        { table: 'workspaces', seq: 50, rows: [{ id: 'workspace-snapshot', title: 'Snapshot' }] },
      ]),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn(), ready: Promise.resolve() })),
    }

    await startAppDataSync({ collections: [synced], client, scope: 'app-cold-start' })

    expect(client.resume).not.toHaveBeenCalled()
    expect(client.snapshotMany).toHaveBeenCalledWith(['workspaces'])
    expect(synced.getRows()).toEqual([{ id: 'workspace-snapshot', title: 'Snapshot' }])
    expect(client.subscribe).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 50 }))
  })

  it('does not resolve startup sync until the realtime subscription is ready', async () => {
    const synced = collection('startup-sync-subscribe-ready')
    await writeLocalSyncCursor('app-ready', { seq: 1 })
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const client: SyncClient = {
      resume: vi.fn(async () => ({ type: 'changes' as const, events: [] })),
      snapshot: vi.fn(),
      snapshotMany: vi.fn(),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn(), ready })),
    }

    let resolved = false
    const started = startAppDataSync({ collections: [synced], client, scope: 'app-ready' }).then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    resolveReady()
    await started

    expect(resolved).toBe(true)
  })

  it('marks collections caught up to the durable cursor when resume has no events', async () => {
    const synced = collection('startup-sync-empty-resume')
    await writeLocalSyncCursor('app-empty-resume', { seq: 42 })
    const client: SyncClient = {
      resume: vi.fn(async () => ({ type: 'changes' as const, events: [] })),
      snapshot: vi.fn(),
      snapshotMany: vi.fn(),
      subscribe: vi.fn(() => ({ unsubscribe: vi.fn(), ready: Promise.resolve() })),
    }

    await startAppDataSync({ collections: [synced], client, scope: 'app-empty-resume' })

    expect(synced.getSeq()).toBe(42)
    expect(client.subscribe).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 42 }))
  })
})
