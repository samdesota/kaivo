import { beforeEach, describe, expect, it, vi } from 'vitest'

type RecentRow = { path: string; label: string | null; lastOpenedAt: string }
const recentRows: RecentRow[] = []
const directoryPaths = new Set<string>()

vi.mock('drizzle-orm', () => ({
  desc: () => ({}),
  eq:
    (col: { _col: string }, val: unknown) =>
    (r: Record<string, unknown>) =>
      r[col._col] === val,
}))

vi.mock('../db/schema.js', () => ({
  recentFolders: {
    _table: 'recent_folders',
    path: { _col: 'path' },
    label: { _col: 'label' },
    lastOpenedAt: { _col: 'lastOpenedAt' },
  },
}))

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        orderBy: () => ({
          all: () => [...recentRows].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)),
        }),
      }),
    }),
    insert: () => ({
      values: (value: RecentRow) => ({
        onConflictDoUpdate: ({ set }: { set: Partial<RecentRow> }) => ({
          run: () => {
            const existing = recentRows.find((r) => r.path === value.path)
            if (existing) Object.assign(existing, set)
            else recentRows.push(value)
          },
        }),
      }),
    }),
    delete: () => ({
      where: (predicate: (row: RecentRow) => boolean) => ({
        run: () => {
          const kept = recentRows.filter((row) => !predicate(row))
          recentRows.splice(0, recentRows.length, ...kept)
        },
      }),
    }),
  },
}))

vi.mock('node:fs/promises', () => ({
  default: {
    stat: vi.fn(async (folderPath: string) => {
      if (!directoryPaths.has(folderPath)) throw new Error('missing')
      return { isDirectory: () => true }
    }),
  },
}))

beforeEach(() => {
  recentRows.length = 0
  directoryPaths.clear()
  vi.resetModules()
})

describe('recent folder service', () => {
  it('upsert refreshes lastOpenedAt and de-duplicates by path', async () => {
    const { recentFolderService } = await import('./service.js')

    const first = recentFolderService.upsert('/tmp/project', 'Project')
    recentRows[0]!.lastOpenedAt = new Date(Date.now() - 60_000).toISOString()
    const second = recentFolderService.upsert('/tmp/project', 'Project renamed')

    expect(first.path).toBe('/tmp/project')
    expect(second.label).toBe('Project renamed')
    expect(recentRows).toHaveLength(1)
    expect(new Date(recentRows[0]!.lastOpenedAt).getTime()).toBeGreaterThan(
      Date.now() - 10_000,
    )
  })

  it('lists only existing directories and prunes missing folders', async () => {
    const { recentFolderService } = await import('./service.js')
    directoryPaths.add('/tmp/existing')
    recentRows.push(
      { path: '/tmp/missing', label: 'Missing', lastOpenedAt: '2026-01-01T00:00:02.000Z' },
      { path: '/tmp/existing', label: 'Existing', lastOpenedAt: '2026-01-01T00:00:01.000Z' },
    )

    const listed = await recentFolderService.list()

    expect(listed.map((folder) => folder.path)).toEqual(['/tmp/existing'])
    expect(recentRows.map((folder) => folder.path)).toEqual(['/tmp/existing'])
  })
})
