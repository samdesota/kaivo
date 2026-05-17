import { describe, expect, it, vi } from 'vitest'
import { workspaceResourceSchema } from '../../server/trpc/routers/workspace'
import {
  bookmarkFromResource,
  bookmarkResourceInput,
  bookmarkResourceKeyForUrl,
  bookmarksFromResources,
  normalizeBookmarkUrl,
} from '../../src/routes/workspace/bookmarks-store'
import { applyWorkspaceResourceChangeEvents, type WorkspaceResourceRecord, type WorkspaceResourcesChangeEvent } from '../../src/routes/workspace/resources-store'
import { createWorkspaceResourceCleanupRegistry } from '../../src/routes/workspace/resource-cleanup'

function resource(overrides: Partial<WorkspaceResourceRecord> = {}): WorkspaceResourceRecord {
  const now = new Date('2026-05-16T12:00:00Z')
  return {
    id: 'resource-1',
    workspaceId: 'workspace-1',
    type: 'bookmark',
    resourceKey: 'bookmark:https://example.com/docs',
    shared: true,
    data: {
      title: 'Example Docs',
      url: 'https://example.com/docs',
      normalizedUrl: 'https://example.com/docs',
      origin: 'https://example.com',
      faviconDataUrl: 'data:image/png;base64,abc',
      faviconUrl: 'https://example.com/favicon.ico',
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('workspace bookmark resources', () => {
  it('maps valid bookmark resources and skips malformed rows', () => {
    const valid = resource()
    expect(bookmarkFromResource(valid)).toMatchObject({
      id: 'resource-1',
      workspaceId: 'workspace-1',
      title: 'Example Docs',
      url: 'https://example.com/docs',
      normalizedUrl: 'https://example.com/docs',
      origin: 'https://example.com',
      faviconDataUrl: 'data:image/png;base64,abc',
      faviconUrl: 'https://example.com/favicon.ico',
    })

    const malformed = resource({ id: 'bad', data: { title: '', url: 'https://example.com' } })
    const wrongType = resource({ id: 'shell', type: 'shell' })
    expect(bookmarksFromResources([valid, malformed, wrongType])).toEqual([bookmarkFromResource(valid)])
  })

  it('generates stable idempotent resource keys for equivalent normalized URLs', () => {
    expect(normalizeBookmarkUrl('HTTPS://Example.COM/')).toBe('https://example.com')
    expect(bookmarkResourceKeyForUrl('HTTPS://Example.COM/')).toBe(bookmarkResourceKeyForUrl('https://example.com'))
    expect(bookmarkResourceInput({ title: 'Example', url: 'HTTPS://Example.COM/' })).toMatchObject({
      type: 'bookmark',
      resourceKey: 'bookmark:https://example.com',
      shared: true,
      data: {
        title: 'Example',
        url: 'https://example.com',
        normalizedUrl: 'https://example.com',
        origin: 'https://example.com',
      },
    })
  })

  it('accepts bookmark resources in tRPC validation and rejects unknown types', () => {
    expect(() => workspaceResourceSchema.parse({ type: 'bookmark', resourceKey: 'bookmark:https://example.com' })).not.toThrow()
    expect(() => workspaceResourceSchema.parse({ type: 'favorite', resourceKey: 'bookmark:https://example.com' })).toThrow()
  })

  it('applies resource collection CDC events with direct write utilities', () => {
    const inserted = resource({ id: 'inserted' })
    const events: WorkspaceResourcesChangeEvent[] = [
      { seq: 1, table: 'workspace_resources', op: 'insert', key: 'inserted', row: { ...inserted, shared: 1, createdAt: inserted.createdAt.toISOString(), updatedAt: inserted.updatedAt.toISOString() } },
      { seq: 2, table: 'workspace_resources', op: 'delete', key: 'deleted', row: null },
      { seq: 1, table: 'workspace_resources', op: 'update', key: 'stale', row: null },
    ]
    const writeUpsert = vi.fn()
    const writeDelete = vi.fn()
    const writeBatch = vi.fn((callback: () => void) => callback())

    const nextSeq = applyWorkspaceResourceChangeEvents({
      events,
      syncedSeq: 0,
      collectionUtils: { writeUpsert, writeDelete, writeBatch } as never,
    })

    expect(writeBatch).toHaveBeenCalledTimes(1)
    expect(writeUpsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'inserted', shared: true }))
    expect(writeDelete).toHaveBeenCalledWith('deleted')
    expect(nextSeq).toBe(2)
  })

  it('rehydrates bookmark favicon metadata from saved resource data', () => {
    const input = bookmarkResourceInput({
      title: 'Docs',
      url: 'https://example.com/docs',
      faviconDataUrl: 'data:image/png;base64,abc',
      faviconUrl: 'https://example.com/favicon.ico',
    })
    const rehydrated = bookmarkFromResource(resource({ data: input.data }))

    expect(rehydrated).toMatchObject({
      title: 'Docs',
      url: 'https://example.com/docs',
      faviconDataUrl: 'data:image/png;base64,abc',
      faviconUrl: 'https://example.com/favicon.ico',
    })
  })

  it('applies realtime bookmark insert, update, and delete events to an observed collection snapshot', () => {
    const records = new Map<string, WorkspaceResourceRecord>()
    const writeBatch = vi.fn((callback: () => void) => callback())
    const collectionUtils = {
      writeBatch,
      writeUpsert: vi.fn((record: WorkspaceResourceRecord) => records.set(record.id, record)),
      writeDelete: vi.fn((id: string) => records.delete(id)),
    }
    const inserted = resource({ id: 'bookmark-1', data: { ...resource().data, title: 'Docs' } })
    const updated = resource({ id: 'bookmark-1', data: { ...resource().data, title: 'Updated Docs' } })

    applyWorkspaceResourceChangeEvents({
      syncedSeq: 0,
      collectionUtils: collectionUtils as never,
      events: [
        { seq: 1, table: 'workspace_resources', op: 'insert', key: 'bookmark-1', row: { ...inserted, shared: 1, createdAt: inserted.createdAt.toISOString(), updatedAt: inserted.updatedAt.toISOString() } },
      ],
    })
    expect(bookmarksFromResources([...records.values()]).map((bookmark) => bookmark.title)).toEqual(['Docs'])

    applyWorkspaceResourceChangeEvents({
      syncedSeq: 1,
      collectionUtils: collectionUtils as never,
      events: [
        { seq: 2, table: 'workspace_resources', op: 'update', key: 'bookmark-1', row: { ...updated, shared: 1, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() } },
      ],
    })
    expect(bookmarksFromResources([...records.values()]).map((bookmark) => bookmark.title)).toEqual(['Updated Docs'])

    applyWorkspaceResourceChangeEvents({
      syncedSeq: 2,
      collectionUtils: collectionUtils as never,
      events: [{ seq: 3, table: 'workspace_resources', op: 'delete', key: 'bookmark-1', row: null }],
    })
    expect(bookmarksFromResources([...records.values()])).toEqual([])
  })

  it('keeps bookmarks out of disposable workspace resource cleanup', async () => {
    const bookmark = resource()
    const registry = createWorkspaceResourceCleanupRegistry({
      workspaceId: 'workspace-1',
      resources: [bookmark],
      listShells: async () => [],
      disposeShell: async () => undefined,
      listWorktrees: async () => [],
      deleteWorktree: async () => undefined,
    })
    const handler = registry.handlerFor('bookmark')
    await expect(handler.exists(bookmark)).resolves.toBe(true)
    expect(handler.row(bookmark)).toMatchObject({ type: 'bookmark', label: 'Example Docs', orphan: false, canCleanup: false })
  })
})
