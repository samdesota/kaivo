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

type WorkspaceAgentTabRow = {
  workspaceId: string
  sessionId: string
  position: number
  updatedAt: Date
}

const workspaceRows: WorkspaceRow[] = []
const uiStateRows: UiStateRow[] = []
const viewStateRows: WorkspaceViewStateRow[] = []
const tabRows: WorkspaceTabRow[] = []
const agentTabRows: WorkspaceAgentTabRow[] = []

function resetState() {
  workspaceRows.length = 0
  uiStateRows.length = 0
  viewStateRows.length = 0
  tabRows.length = 0
  agentTabRows.length = 0
}

vi.mock('drizzle-orm', () => ({
  and:
    (...preds: Array<(r: Record<string, unknown>) => boolean>) =>
    (r: Record<string, unknown>) =>
      preds.every((pred) => pred(r)),
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
  workspaceAgentTabs: {
    _table: 'workspace_agent_tabs',
    workspaceId: { _col: 'workspaceId' },
    sessionId: { _col: 'sessionId' },
    position: { _col: 'position' },
  },
}))

function rowsFor(table: { _table: string }) {
  if (table._table === 'workspaces') return workspaceRows
  if (table._table === 'workspace_ui_states') return uiStateRows
  if (table._table === 'workspace_view_states') return viewStateRows
  if (table._table === 'workspace_agent_tabs') return agentTabRows
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
        } else if (table._table === 'workspace_tabs') {
          for (const row of values as WorkspaceTabRow[]) {
            const idx = tabRows.findIndex((r) => r.workspaceId === row.workspaceId && r.id === row.id)
            if (idx >= 0) tabRows[idx] = row
            else tabRows.push(row)
          }
        } else {
          for (const row of values as WorkspaceAgentTabRow[]) {
            const idx = agentTabRows.findIndex((r) => r.workspaceId === row.workspaceId && r.sessionId === row.sessionId)
            if (idx >= 0) agentTabRows[idx] = row
            else agentTabRows.push(row)
          }
        }
        return {
          onConflictDoUpdate: async ({ set }: { set: Partial<UiStateRow | WorkspaceViewStateRow | WorkspaceTabRow | WorkspaceAgentTabRow> }) => {
            if (table._table === 'workspace_tabs' || table._table === 'workspace_agent_tabs') {
              return
            }
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
        const ordered = (pred?: (r: Record<string, unknown>) => boolean) => {
          const rows = apply(pred)
          if (table._table !== 'workspace_tabs' && table._table !== 'workspace_agent_tabs') return rows
          return [...rows].sort((a, b) => {
            const pos = Number(a.position ?? 0) - Number(b.position ?? 0)
            if (pos !== 0) return pos
            return String(a.id ?? a.sessionId ?? '').localeCompare(String(b.id ?? b.sessionId ?? ''))
          })
        }
        return {
          where: (pred: (r: Record<string, unknown>) => boolean) => ({
            limit: async (n: number) => apply(pred).slice(0, n),
            orderBy: async () => ordered(pred),
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

  it('persists workspace view state without rewriting tabs', async () => {
    const { workspaceRouter } = await import('../trpc/routers/workspace.js')
    const caller = workspaceRouter.createCaller(makeCtx())
    const workspace = await caller.create({ name: 'View state workspace' })

    await caller.saveUiState({
      workspaceId: workspace.id,
      state: {
        activeAgentSessionId: null,
        activeWorkspaceTabId: 'tab-1',
        workspaceTabs: [{ id: 'tab-1', type: 'browser' as const, url: 'https://example.com', title: 'Example' }],
        splitRatio: 0.5,
        agentCollapsed: false,
        tabOrder: ['tab-1'],
      },
    })

    await caller.saveViewState({
      workspaceId: workspace.id,
      state: { activeAgentSessionId: 'agent-1', splitRatio: 0.42, agentCollapsed: true },
    })

    await expect(caller.getViewState({ workspaceId: workspace.id })).resolves.toMatchObject({
      workspaceId: workspace.id,
      activeAgentSessionId: 'agent-1',
      activeWorkspaceTabId: 'tab-1',
      splitRatio: 0.42,
      agentCollapsed: true,
    })
    await expect(caller.getUiState({ workspaceId: workspace.id })).resolves.toMatchObject({
      workspaceTabs: [{ id: 'tab-1', type: 'browser', url: 'https://example.com', title: 'Example' }],
    })
  })

  it('persists workspace tabs through granular endpoints', async () => {
    const { workspaceRouter } = await import('../trpc/routers/workspace.js')
    const caller = workspaceRouter.createCaller(makeCtx())
    const workspace = await caller.create({ name: 'Tabs workspace' })

    await caller.upsertTab({
      workspaceId: workspace.id,
      position: 0,
      tab: { id: 'tab-1', type: 'browser', url: 'https://example.com', title: 'Example' },
    })
    await caller.upsertTab({
      workspaceId: workspace.id,
      position: 1,
      tab: { id: 'tab-2', type: 'shell', envId: 'env-1', shellId: 'shell-1', title: 'Shell' },
    })
    await caller.upsertTab({
      workspaceId: workspace.id,
      position: 0,
      tab: { id: 'tab-1', type: 'browser', url: 'https://example.com', browserTabId: 'browser-1', title: 'Updated' },
    })

    await expect(caller.listTabs({ workspaceId: workspace.id })).resolves.toMatchObject([
      { id: 'tab-1', title: 'Updated', position: 0, browserTabId: 'browser-1' },
      { id: 'tab-2', title: 'Shell', position: 1, shellId: 'shell-1' },
    ])

    await caller.deleteTab({ workspaceId: workspace.id, tabId: 'tab-1' })
    await expect(caller.listTabs({ workspaceId: workspace.id })).resolves.toMatchObject([
      { id: 'tab-2', title: 'Shell' },
    ])
  })

  it('persists workspace agent tab order through granular endpoints', async () => {
    const { workspaceRouter } = await import('../trpc/routers/workspace.js')
    const caller = workspaceRouter.createCaller(makeCtx())
    const workspace = await caller.create({ name: 'Agent tabs workspace' })

    await caller.upsertAgentTab({ workspaceId: workspace.id, sessionId: 'session-1', position: 0 })
    await caller.upsertAgentTab({ workspaceId: workspace.id, sessionId: 'session-2', position: 1 })
    await caller.upsertAgentTab({ workspaceId: workspace.id, sessionId: 'session-1', position: 2 })

    await expect(caller.listAgentTabs({ workspaceId: workspace.id })).resolves.toMatchObject([
      { workspaceId: workspace.id, sessionId: 'session-2', position: 1 },
      { workspaceId: workspace.id, sessionId: 'session-1', position: 2 },
    ])

    await caller.deleteAgentTab({ workspaceId: workspace.id, sessionId: 'session-2' })
    await expect(caller.listAgentTabs({ workspaceId: workspace.id })).resolves.toMatchObject([
      { workspaceId: workspace.id, sessionId: 'session-1', position: 2 },
    ])
  })
})
