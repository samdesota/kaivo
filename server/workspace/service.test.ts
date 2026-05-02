import { beforeEach, describe, expect, it, vi } from 'vitest'

type WorkspaceRow = {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
  lastOpenedAt: Date | null
  archivedAt: Date | null
}

type WorkspaceUiState = {
  activeAgentSessionId: string | null
  activeWorkspaceTabId: string | null
  workspaceTabs: Array<Record<string, unknown>>
  splitRatio: number | null
  agentCollapsed: boolean
  tabOrder: string[]
}

type UiStateRow = {
  workspaceId: string
  state: WorkspaceUiState
  updatedAt: Date
}

type WorkspaceViewStateRow = {
  workspaceId: string
  activeAgentSessionId: string | null
  activeWorkspaceTabId: string | null
  splitRatio: number | null
  agentCollapsed: boolean
  updatedAt: Date
}

type WorkspaceTabRow = {
  workspaceId: string
  id: string
  type: string
  title: string
  position: number
  envId: string | null
  shellId: string | null
  path: string | null
  sessionId: string | null
  port: number | null
  url: string | null
  browserTabId: string | null
  updatedAt: Date
}

const workspaceRows: WorkspaceRow[] = []
const uiStateRows: UiStateRow[] = []
const viewStateRows: WorkspaceViewStateRow[] = []
const tabRows: WorkspaceTabRow[] = []

function resetState() {
  workspaceRows.length = 0
  uiStateRows.length = 0
  viewStateRows.length = 0
  tabRows.length = 0
}

vi.mock('drizzle-orm', () => ({
  asc: () => ({}),
  desc: () => ({}),
  sql: (strings: TemplateStringsArray) => strings.join(''),
  eq:
    (col: { _col: string }, val: unknown) =>
    (r: Record<string, unknown>) =>
      r[col._col] === val,
  isNull:
    (col: { _col: string }) =>
    (r: Record<string, unknown>) =>
      r[col._col] === null || r[col._col] === undefined,
}))

vi.mock('../db/schema.js', () => ({
  workspaces: {
    _table: 'workspaces',
    id: { _col: 'id' },
    name: { _col: 'name' },
    createdAt: { _col: 'createdAt' },
    updatedAt: { _col: 'updatedAt' },
    lastOpenedAt: { _col: 'lastOpenedAt' },
    archivedAt: { _col: 'archivedAt' },
  },
  workspaceUiStates: {
    _table: 'workspace_ui_states',
    workspaceId: { _col: 'workspaceId' },
    state: { _col: 'state' },
    updatedAt: { _col: 'updatedAt' },
  },
  workspaceViewStates: {
    _table: 'workspace_view_states',
    workspaceId: { _col: 'workspaceId' },
    activeAgentSessionId: { _col: 'activeAgentSessionId' },
    activeWorkspaceTabId: { _col: 'activeWorkspaceTabId' },
    splitRatio: { _col: 'splitRatio' },
    agentCollapsed: { _col: 'agentCollapsed' },
    updatedAt: { _col: 'updatedAt' },
  },
  workspaceTabs: {
    _table: 'workspace_tabs',
    workspaceId: { _col: 'workspaceId' },
    id: { _col: 'id' },
    position: { _col: 'position' },
  },
}))

function rowsFor(table: { _table: string }) {
  if (table._table === 'workspaces') return workspaceRows
  if (table._table === 'workspace_ui_states') return uiStateRows
  if (table._table === 'workspace_view_states') return viewStateRows
  return tabRows
}

vi.mock('../db/client.js', () => ({
  db: {
    insert: (table: { _table: string }) => ({
      values: (value: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const values = Array.isArray(value) ? value : [value]
        if (table._table === 'workspaces') {
          workspaceRows.push(...(values as WorkspaceRow[]))
        } else if (table._table === 'workspace_ui_states') {
          for (const row of values as UiStateRow[]) {
            const idx = uiStateRows.findIndex((r) => r.workspaceId === row.workspaceId)
            if (idx >= 0) uiStateRows[idx] = row
            else uiStateRows.push(row)
          }
        } else if (table._table === 'workspace_view_states') {
          for (const row of values as WorkspaceViewStateRow[]) {
            const idx = viewStateRows.findIndex((r) => r.workspaceId === row.workspaceId)
            if (idx >= 0) viewStateRows[idx] = row
            else viewStateRows.push(row)
          }
        } else {
          tabRows.push(...(values as WorkspaceTabRow[]))
        }
        return {
          onConflictDoUpdate: async ({ set }: { set: Partial<UiStateRow | WorkspaceViewStateRow> }) => {
            if (table._table === 'workspace_tabs') return
            const row = values[0] as UiStateRow | WorkspaceViewStateRow
            const rows = rowsFor(table) as Array<UiStateRow | WorkspaceViewStateRow>
            const existing = rows.find((r) => r.workspaceId === row.workspaceId)
            if (existing) Object.assign(existing, set)
          },
        }
      },
    }),
    select: () => ({
      from: (table: { _table: string }) => {
        const apply = (pred?: (r: Record<string, unknown>) => boolean) => {
          const rows = rowsFor(table) as unknown as Record<string, unknown>[]
          return pred ? rows.filter(pred) : rows
        }
        return {
          where: (pred: (r: Record<string, unknown>) => boolean) => ({
            limit: async (n: number) => apply(pred).slice(0, n),
            orderBy: async () => apply(pred),
          }),
        }
      },
    }),
    update: (table: { _table: string }) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (pred: (r: Record<string, unknown>) => boolean) => {
          const updated: Array<Record<string, unknown>> = []
          for (const row of rowsFor(table) as unknown as Record<string, unknown>[]) {
            if (pred(row)) {
              Object.assign(row, vals)
              updated.push(row)
            }
          }
          return { returning: async () => updated }
        },
      }),
    }),
    delete: (table: { _table: string }) => ({
      where: async (pred: (r: Record<string, unknown>) => boolean) => {
        const rows = rowsFor(table) as unknown as Record<string, unknown>[]
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const row = rows[i]
          if (row && pred(row)) rows.splice(i, 1)
        }
      },
    }),
  },
}))

function makeCtx() {
  return {
    req: { headers: {} } as unknown as import('@trpc/server/adapters/fastify').CreateFastifyContextOptions['req'],
    res: {} as unknown as import('@trpc/server/adapters/fastify').CreateFastifyContextOptions['res'],
    ip: '127.0.0.1',
    session: { id: 'sess-1', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), lastSeen: new Date() } as import('../auth/service.js').Session,
  }
}

beforeEach(() => {
  resetState()
  vi.clearAllMocks()
})

describe('workspace service', () => {
  it('creates, renames, archives, and orders workspaces by recent activity', async () => {
    const { workspaceService } = await import('./service.js')

    const first = await workspaceService.create({ name: 'First' })
    const second = await workspaceService.create({ name: 'Second' })
    workspaceRows.find((r) => r.id === second.id)!.lastOpenedAt = new Date(Date.now() - 10_000)
    await workspaceService.markOpened(first.id)

    let rows = await workspaceService.list()
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id])

    const renamed = await workspaceService.rename(first.id, 'Renamed')
    expect(renamed.name).toBe('Renamed')

    await workspaceService.archive(first.id)
    rows = await workspaceService.list()
    expect(rows.map((r) => r.id)).toEqual([second.id])
  })
})

describe('workspace router', () => {
  it('persists and reloads UI state for a workspace', async () => {
    const { workspaceRouter } = await import('../trpc/routers/workspace.js')
    const caller = workspaceRouter.createCaller(makeCtx())
    const workspace = await caller.create({ name: 'Router workspace' })
    const state = {
      activeAgentSessionId: 'agent-1',
      activeWorkspaceTabId: 'tab-1',
      workspaceTabs: [{ id: 'tab-1', type: 'browser' as const, url: 'https://example.com', title: 'Example' }],
      splitRatio: 0.42,
      agentCollapsed: true,
      tabOrder: ['tab-1'],
    }

    await caller.saveUiState({ workspaceId: workspace.id, state })
    await expect(caller.getUiState({ workspaceId: workspace.id })).resolves.toEqual(state)
  })
})
