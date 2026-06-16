import { describe, expect, it, vi } from 'vitest'
import { workspaceResourceSchema } from '../../server/trpc/routers/workspace'
import {
  applyBookmarkChangeEvents,
  bookmarkInput,
  normalizeBookmarkRecord,
  normalizeBookmarkUrl,
  validBookmarks,
  type BookmarkRecord,
} from '../../src/routes/workspace/bookmarks-store'
import { createWorkspaceResourceCleanupRegistry } from '../../src/routes/workspace/resource-cleanup'
import {
  applyWorkspaceResourceChangeEvents,
  type WorkspaceResourceRecord,
} from '../../src/routes/workspace/resources-store'

function bookmark(overrides: Partial<BookmarkRecord> = {}): BookmarkRecord {
  const now = new Date('2026-05-16T12:00:00Z')
  return {
    id: 'bookmark-1',
    title: 'Example Docs',
    url: 'https://example.com/docs',
    normalizedUrl: 'https://example.com/docs',
    origin: 'https://example.com',
    faviconDataUrl: 'data:image/png;base64,abc',
    faviconUrl: 'https://example.com/favicon.ico',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('global bookmarks store', () => {
  it('normalizes bookmark rows and skips malformed rows', () => {
    const valid = bookmark()
    expect(normalizeBookmarkRecord({ ...valid, createdAt: valid.createdAt.toISOString(), updatedAt: valid.updatedAt.toISOString() })).toMatchObject({
      id: 'bookmark-1',
      title: 'Example Docs',
      url: 'https://example.com/docs',
      normalizedUrl: 'https://example.com/docs',
      origin: 'https://example.com',
      faviconDataUrl: 'data:image/png;base64,abc',
      faviconUrl: 'https://example.com/favicon.ico',
    })

    const malformed = bookmark({ id: 'bad', title: '', url: 'https://example.com' })
    expect(validBookmarks([valid, malformed])).toEqual([valid])
  })

  it('generates stable idempotent inputs for equivalent normalized URLs', () => {
    expect(normalizeBookmarkUrl('HTTPS://Example.COM/')).toBe('https://example.com')
    expect(bookmarkInput({ title: 'Example', url: 'HTTPS://Example.COM/' })).toMatchObject({
      title: 'Example',
      url: 'https://example.com',
      faviconDataUrl: null,
      faviconUrl: null,
    })
  })

  it('rejects bookmark rows in workspace resource validation', () => {
    expect(() => workspaceResourceSchema.parse({ type: 'bookmark', resourceKey: 'bookmark:https://example.com' })).toThrow()
    expect(() => workspaceResourceSchema.parse({ type: 'favorite', resourceKey: 'bookmark:https://example.com' })).toThrow()
  })

  it('applies realtime bookmark insert, update, and delete events to an observed collection snapshot', () => {
    const records = new Map<string, BookmarkRecord>()
    const writeBatch = vi.fn((callback: () => void) => callback())
    const collectionUtils = {
      writeBatch,
      writeUpsert: vi.fn((record: BookmarkRecord) => records.set(record.id, record)),
      writeDelete: vi.fn((id: string) => records.delete(id)),
    }
    const inserted = bookmark({ id: 'bookmark-1', title: 'Docs' })
    const updated = bookmark({ id: 'bookmark-1', title: 'Updated Docs' })

    applyBookmarkChangeEvents({
      syncedSeq: 0,
      collectionUtils: collectionUtils as never,
      events: [
        { seq: 1, table: 'bookmarks', op: 'insert', key: 'bookmark-1', row: { ...inserted, createdAt: inserted.createdAt.toISOString(), updatedAt: inserted.updatedAt.toISOString() } },
      ],
    })
    expect([...records.values()].map((record) => record.title)).toEqual(['Docs'])

    applyBookmarkChangeEvents({
      syncedSeq: 1,
      collectionUtils: collectionUtils as never,
      events: [
        { seq: 2, table: 'bookmarks', op: 'update', key: 'bookmark-1', row: { ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() } },
      ],
    })
    expect([...records.values()].map((record) => record.title)).toEqual(['Updated Docs'])

    applyBookmarkChangeEvents({
      syncedSeq: 2,
      collectionUtils: collectionUtils as never,
      events: [{ seq: 3, table: 'bookmarks', op: 'delete', key: 'bookmark-1', row: null }],
    })
    expect([...records.values()]).toEqual([])
  })

  it('skips realtime bookmark deletes for rows outside the observed collection', () => {
    const collectionUtils = {
      writeBatch: vi.fn((callback: () => void) => callback()),
      writeUpsert: vi.fn(),
      writeDelete: vi.fn(() => {
        throw new Error('missing key')
      }),
    }

    const seq = applyBookmarkChangeEvents({
      syncedSeq: 0,
      collectionUtils: collectionUtils as never,
      collectionHas: () => false,
      events: [{ seq: 1, table: 'bookmarks', op: 'delete', key: 'missing-bookmark', row: null }],
    })

    expect(seq).toBe(1)
    expect(collectionUtils.writeDelete).not.toHaveBeenCalled()
  })

  it('skips realtime workspace resource deletes for rows outside the observed collection', () => {
    const collectionUtils = {
      writeBatch: vi.fn((callback: () => void) => callback()),
      writeUpsert: vi.fn(),
      writeDelete: vi.fn(() => {
        throw new Error('missing key')
      }),
    }

    const seq = applyWorkspaceResourceChangeEvents({
      syncedSeq: 0,
      collectionUtils: collectionUtils as never,
      collectionHas: () => false,
      events: [{ seq: 1, table: 'workspace_resources', op: 'delete', key: 'missing-resource', row: null }],
    })

    expect(seq).toBe(1)
    expect(collectionUtils.writeDelete).not.toHaveBeenCalled()
  })

  it('does not have bookmark-specific workspace resource cleanup', async () => {
    const resource: WorkspaceResourceRecord = {
      id: 'resource-1',
      workspaceId: 'workspace-1',
      type: 'other',
      resourceKey: 'bookmark:https://example.com/docs',
      shared: true,
      data: { title: 'Example Docs' },
      createdAt: new Date('2026-05-16T12:00:00Z'),
      updatedAt: new Date('2026-05-16T12:00:00Z'),
    }
    const registry = createWorkspaceResourceCleanupRegistry({
      workspaceId: 'workspace-1',
      resources: [resource],
      listShells: async () => [],
      disposeShell: async () => undefined,
      listWorktrees: async () => [],
      deleteWorktree: async () => undefined,
    })
    const handler = registry.handlerFor('bookmark')
    await expect(handler.exists(resource)).resolves.toBe(true)
    expect(handler.row(resource)).toMatchObject({ type: 'other', label: 'Example Docs', orphan: true, canCleanup: true })
  })

  it('discovers untracked live shell resources for cleanup', async () => {
    const registry = createWorkspaceResourceCleanupRegistry({
      workspaceId: 'workspace-1',
      resources: [],
      listShells: async () => [
        { id: 'shell-1', cwd: '/tmp/project', title: 'dev shell', alive: true },
        { id: 'shell-dead', cwd: '/tmp/project', title: null, alive: false },
      ],
      disposeShell: async () => undefined,
      listWorktrees: async () => [],
      deleteWorktree: async () => undefined,
    })

    const discovered = await registry.handlerFor('shell').discover?.()

    expect(discovered).toHaveLength(1)
    expect(discovered?.[0]).toMatchObject({
      id: 'discovered:shell:shell-1',
      workspaceId: 'workspace-1',
      type: 'shell',
      resourceKey: 'shell-1',
      data: { shellId: 'shell-1', cwd: '/tmp/project', title: 'dev shell' },
    })
    expect(registry.handlerFor('shell').row(discovered![0])).toMatchObject({ id: 'discovered:shell:shell-1', type: 'shell', label: 'dev shell', detail: '/tmp/project', canCleanup: true })
  })
})
