import { beforeEach, describe, expect, it, vi } from 'vitest'

type WorkspaceRow = {
  id: string
  name: string
  folderId: string | null
  position: number
  nameSource: 'explicit' | 'folder_path' | 'worktree' | 'derived'
  sourceKind: 'folder' | 'worktree' | 'repo_config' | null
  sourcePath: string | null
  kind: 'user' | 'system'
  systemKey: 'global-tabs' | null
  hidden: boolean
  protected: boolean
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
  titleSource: 'auto' | 'explicit' | null
  position: number
  envId: string | null
  shellId: string | null
  path: string | null
  repoRoot: string | null
  sessionId: string | null
  port: number | null
  url: string | null
  browserTabId: string | null
  faviconUrl: string | null
  updatedAt: Date
}

type WorkspaceAgentTabRow = {
  workspaceId: string
  sessionId: string
  position: number
  updatedAt: Date
}

type WorkspaceResourceRow = {
  id: string
  workspaceId: string
  type: 'browser_tab' | 'worktree' | 'shell' | 'other'
  resourceKey: string
  shared: boolean
  data: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

type AgentNotificationRow = {
  id: string
  workspaceId: string
  sessionId: string
  kind: 'finished' | 'question' | 'permission' | 'error'
  title: string
  summary: string
  createdAt: Date
}

type WorkspaceFolderRow = {
  id: string
  parentId: string | null
  name: string
  position: number
  collapsed: boolean
  createdAt: Date
  updatedAt: Date
  archivedAt: Date | null
}

const workspaceRows: WorkspaceRow[] = []
const folderRows: WorkspaceFolderRow[] = []
const uiStateRows: UiStateRow[] = []
const viewStateRows: WorkspaceViewStateRow[] = []
const tabRows: WorkspaceTabRow[] = []
const agentTabRows: WorkspaceAgentTabRow[] = []
const resourceRows: WorkspaceResourceRow[] = []
const notificationRows: AgentNotificationRow[] = []

function resetState() {
  workspaceRows.length = 0
  folderRows.length = 0
  uiStateRows.length = 0
  viewStateRows.length = 0
  tabRows.length = 0
  agentTabRows.length = 0
  resourceRows.length = 0
  notificationRows.length = 0
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
    folderId: { _col: 'folderId' },
    position: { _col: 'position' },
    nameSource: { _col: 'nameSource' },
    sourceKind: { _col: 'sourceKind' },
    sourcePath: { _col: 'sourcePath' },
    kind: { _col: 'kind' },
    systemKey: { _col: 'systemKey' },
    hidden: { _col: 'hidden' },
    protected: { _col: 'protected' },
    createdAt: { _col: 'createdAt' },
    updatedAt: { _col: 'updatedAt' },
    lastOpenedAt: { _col: 'lastOpenedAt' },
    archivedAt: { _col: 'archivedAt' },
  },
  workspaceFolders: {
    _table: 'workspace_folders',
    id: { _col: 'id' },
    parentId: { _col: 'parentId' },
    name: { _col: 'name' },
    position: { _col: 'position' },
    collapsed: { _col: 'collapsed' },
    createdAt: { _col: 'createdAt' },
    updatedAt: { _col: 'updatedAt' },
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
    repoRoot: { _col: 'repoRoot' },
  },
  workspaceAgentTabs: {
    _table: 'workspace_agent_tabs',
    workspaceId: { _col: 'workspaceId' },
    sessionId: { _col: 'sessionId' },
    position: { _col: 'position' },
  },
  workspaceResources: {
    _table: 'workspace_resources',
    id: { _col: 'id' },
    workspaceId: { _col: 'workspaceId' },
    type: { _col: 'type' },
    resourceKey: { _col: 'resourceKey' },
    shared: { _col: 'shared' },
    data: { _col: 'data' },
    createdAt: { _col: 'createdAt' },
    updatedAt: { _col: 'updatedAt' },
  },
  agentNotifications: {
    _table: 'agent_notifications',
    id: { _col: 'id' },
    workspaceId: { _col: 'workspaceId' },
    sessionId: { _col: 'sessionId' },
    summary: { _col: 'summary' },
    createdAt: { _col: 'createdAt' },
  },
}))

vi.mock('../envauth/service.js', () => ({
  resolveEnvAuthToken: vi.fn(async (token: string) =>
    token === 'identity-token' ? { tokenHash: 'hash-1', label: 'test env', issuedBy: 'test' } : null,
  ),
}))

function rowsFor(table: { _table: string }) {
  if (table._table === 'workspaces') return workspaceRows
  if (table._table === 'workspace_folders') return folderRows
  if (table._table === 'workspace_ui_states') return uiStateRows
  if (table._table === 'workspace_view_states') return viewStateRows
  if (table._table === 'workspace_agent_tabs') return agentTabRows
  if (table._table === 'workspace_resources') return resourceRows
  if (table._table === 'agent_notifications') return notificationRows
  return tabRows
}

vi.mock('../db/client.js', () => ({
  db: {
    insert: (table: { _table: string }) => ({
      values: (value: Record<string, unknown> | Array<Record<string, unknown>>) => {
        const values = Array.isArray(value) ? value : [value]
        if (table._table === 'workspaces') {
          workspaceRows.push(...(values as WorkspaceRow[]))
        } else if (table._table === 'workspace_folders') {
          folderRows.push(...(values as WorkspaceFolderRow[]))
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
        } else if (table._table === 'workspace_agent_tabs') {
          for (const row of values as WorkspaceAgentTabRow[]) {
            const idx = agentTabRows.findIndex((r) => r.workspaceId === row.workspaceId && r.sessionId === row.sessionId)
            if (idx >= 0) agentTabRows[idx] = row
            else agentTabRows.push(row)
          }
        } else if (table._table === 'workspace_resources') {
          for (const row of values as WorkspaceResourceRow[]) {
            const idx = resourceRows.findIndex((r) => r.id === row.id)
            if (idx >= 0) resourceRows[idx] = row
            else resourceRows.push(row)
          }
        } else if (table._table === 'agent_notifications') {
          notificationRows.push(...(values as AgentNotificationRow[]))
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
          if (table._table === 'workspaces' || table._table === 'workspace_folders') {
            return [...rows].sort((a, b) => {
              const pos = Number(a.position ?? 0) - Number(b.position ?? 0)
              if (pos !== 0) return pos
              const aCreated = a.createdAt instanceof Date ? a.createdAt.getTime() : 0
              const bCreated = b.createdAt instanceof Date ? b.createdAt.getTime() : 0
              if (aCreated !== bCreated) return aCreated - bCreated
              return String(a.id ?? '').localeCompare(String(b.id ?? ''))
            })
          }
          if (table._table !== 'workspace_tabs' && table._table !== 'workspace_agent_tabs' && table._table !== 'workspace_resources') return rows
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

function makeIdentityCtx(token = 'identity-token') {
  return {
    req: { headers: { authorization: `Bearer ${token}` } } as unknown as import('@trpc/server/adapters/fastify').CreateFastifyContextOptions['req'],
    res: {} as unknown as import('@trpc/server/adapters/fastify').CreateFastifyContextOptions['res'],
    ip: '127.0.0.1',
    session: null,
  }
}

beforeEach(() => {
  resetState()
  vi.clearAllMocks()
})

describe('workspace service', () => {
  it('round trips git diff rows and includes repoRoot in equality', async () => {
    const { rowToTab, sameWorkspaceTabRow, tabToRow } = await import('./service.js')
    const updatedAt = new Date(1234)
    const tab = { id: 'diff-1', type: 'git-diff' as const, envId: 'env-1', repoRoot: '/repo', title: 'Git Diff' }
    const row = tabToRow('workspace-1', tab, 3, updatedAt)

    expect(row).toMatchObject({ type: 'git-diff', envId: 'env-1', repoRoot: '/repo', position: 3 })
    expect(rowToTab(row)).toEqual(tab)
    expect(sameWorkspaceTabRow(row, { ...row, updatedAt: new Date(9999) })).toBe(true)
    expect(sameWorkspaceTabRow(row, { ...row, repoRoot: '/other' })).toBe(false)
  })

  it('creates, renames, archives, and keeps stable workspace order', async () => {
    const { workspaceService } = await import('./service.js')

    const first = await workspaceService.create({ name: 'First' })
    const second = await workspaceService.create({ name: 'Second' })
    workspaceRows.find((r) => r.id === second.id)!.lastOpenedAt = new Date(Date.now() - 10_000)
    await workspaceService.markOpened(first.id)

    let rows = await workspaceService.list()
    expect(rows.map((r) => r.id)).toEqual([first.id, second.id])
    expect(rows.map((r) => r.position)).toEqual([0, 1])

    const renamed = await workspaceService.rename(first.id, 'Renamed')
    expect(renamed.name).toBe('Renamed')
    expect(renamed.nameSource).toBe('explicit')

    await workspaceService.archive(first.id)
    rows = await workspaceService.list()
    expect(rows.map((r) => r.id)).toEqual([second.id])
  })

  it('creates workspaces with default folder placement and explicit name source', async () => {
    const { workspaceService } = await import('./service.js')

    const workspace = await workspaceService.create({ name: 'Project' })

    expect(workspace).toMatchObject({
      name: 'Project',
      folderId: null,
      position: 0,
      nameSource: 'explicit',
      sourceKind: null,
      sourcePath: null,
      kind: 'user',
      systemKey: null,
      hidden: false,
      protected: false,
    })
    expect(workspaceRows[0]).toMatchObject({ folderId: null, position: 0, nameSource: 'explicit', kind: 'user' })
  })

  it('creates the global-tabs system workspace idempotently', async () => {
    const { workspaceService, GLOBAL_TABS_SYSTEM_WORKSPACE_KEY } = await import('./service.js')

    const first = await workspaceService.getOrCreateGlobalTabsWorkspace()
    const second = await workspaceService.getOrCreateGlobalTabsWorkspace()

    expect(second.id).toBe(first.id)
    expect(workspaceRows).toHaveLength(1)
    expect(first).toMatchObject({
      name: 'Global tabs',
      kind: 'system',
      systemKey: GLOBAL_TABS_SYSTEM_WORKSPACE_KEY,
      hidden: true,
      protected: true,
      folderId: null,
      lastOpenedAt: null,
    })
  })

  it('excludes the hidden system workspace from list and tree while internal lookup can retrieve it', async () => {
    const { workspaceService } = await import('./service.js')

    const system = await workspaceService.getOrCreateGlobalTabsWorkspace()
    const user = await workspaceService.create({ name: 'User workspace' })

    await expect(workspaceService.list()).resolves.toMatchObject([{ id: user.id }])
    await expect(workspaceService.listTree()).resolves.toMatchObject([{ type: 'workspace', workspace: { id: user.id } }])
    await expect(workspaceService.get(system.id)).resolves.toMatchObject({ id: system.id, kind: 'system' })
  })

  it('rejects rename, archive, move, and folder archive operations for protected system workspaces', async () => {
    const { workspaceService } = await import('./service.js')

    const folder = await workspaceService.createFolder({ name: 'System parent' })
    const system = await workspaceService.getOrCreateGlobalTabsWorkspace()

    await expect(workspaceService.rename(system.id, 'Renamed')).rejects.toThrow(/system workspace/i)
    await expect(workspaceService.archive(system.id)).rejects.toThrow(/system workspace/i)
    await expect(workspaceService.moveSidebarNode({ nodeType: 'workspace', nodeId: system.id, parentFolderId: folder.id })).rejects.toThrow(/system workspace/i)

    workspaceRows.find((row) => row.id === system.id)!.folderId = folder.id
    await expect(workspaceService.archiveFolder(folder.id)).rejects.toThrow(/system workspace/i)
  })

  it('keeps landing default selection on user workspaces when the system workspace exists', async () => {
    const { workspaceService } = await import('./service.js')
    const { chooseWorkspaceLandingAction } = await import('../../src/routes/workspace-landing-state.js')

    await workspaceService.getOrCreateGlobalTabsWorkspace()
    expect(chooseWorkspaceLandingAction(false, await workspaceService.list())).toEqual({ type: 'create' })

    const user = await workspaceService.create({ name: 'User workspace' })
    expect(chooseWorkspaceLandingAction(false, await workspaceService.list())).toEqual({ type: 'open', workspaceId: user.id })
  })

  it('creates and dismisses agent notifications in app storage', async () => {
    const { workspaceService } = await import('./service.js')
    const workspace = await workspaceService.create({ name: 'Project' })

    const notification = await workspaceService.createAgentNotification({
      workspaceId: workspace.id,
      sessionId: 'session-1',
      kind: 'finished',
      title: 'Build notifications',
      summary: 'Implemented notifications',
    })

    expect(notificationRows).toHaveLength(1)
    expect(notificationRows[0]).toMatchObject({
      id: notification.id,
      workspaceId: workspace.id,
      sessionId: 'session-1',
      kind: 'finished',
      title: 'Build notifications',
      summary: 'Implemented notifications',
    })

    await workspaceService.dismissAgentNotificationsForSession('session-1')
    expect(notificationRows).toEqual([])
  })

  it('creates agent notifications regardless of saved active chat state', async () => {
    const { workspaceService } = await import('./service.js')
    const workspace = await workspaceService.create({ name: 'Project' })
    await workspaceService.saveViewState(workspace.id, { activeAgentSessionId: 'session-1' })

    const notification = await workspaceService.createAgentNotification({
      workspaceId: workspace.id,
      sessionId: 'session-1',
      title: 'Build notifications',
      summary: 'Implemented notifications',
    })

    expect(notification).toMatchObject({ workspaceId: workspace.id, sessionId: 'session-1' })
    expect(notificationRows).toHaveLength(1)
  })

  it('does not rewrite view state when the patch is unchanged', async () => {
    const { workspaceService } = await import('./service.js')
    const workspace = await workspaceService.create({ name: 'Project' })
    const saved = await workspaceService.saveViewState(workspace.id, { activeAgentSessionId: 'session-1' })

    const result = await workspaceService.saveViewState(workspace.id, { activeAgentSessionId: 'session-1' })

    expect(result.updatedAt).toBe(saved.updatedAt)
    expect(viewStateRows).toHaveLength(1)
    expect(viewStateRows[0]?.updatedAt).toBe(saved.updatedAt)
  })

  it('returns folders and workspaces ordered by parent and position', async () => {
    const { workspaceService } = await import('./service.js')

    const folder = await workspaceService.createFolder({ name: 'Kaivo' })
    const nested = await workspaceService.createFolder({ name: 'Packages', parentId: folder.id })
    const rootWorkspace = await workspaceService.create({ name: 'Scratch' })
    const childWorkspace = await workspaceService.create({ name: 'kaivo', folderId: folder.id })
    const nestedWorkspace = await workspaceService.create({ name: 'plugin', folderId: nested.id })

    await expect(workspaceService.listTree()).resolves.toMatchObject([
      {
        type: 'folder',
        folder: { id: folder.id, name: 'Kaivo', position: 0 },
        children: [
          { type: 'folder', folder: { id: nested.id, name: 'Packages', position: 0 }, children: [{ type: 'workspace', workspace: { id: nestedWorkspace.id } }] },
          { type: 'workspace', workspace: { id: childWorkspace.id, position: 1 } },
        ],
      },
      { type: 'workspace', workspace: { id: rootWorkspace.id, position: 1 } },
    ])
  })

  it('appends new workspaces under a folder without changing existing positions', async () => {
    const { workspaceService } = await import('./service.js')

    const folder = await workspaceService.createFolder({ name: 'Starch' })
    const first = await workspaceService.create({ name: 'starch-web', folderId: folder.id })
    const second = await workspaceService.create({ name: 'starch-api', folderId: folder.id })

    await workspaceService.markOpened(second.id)
    await workspaceService.rename(first.id, 'starch-ui')

    expect(workspaceRows.find((row) => row.id === first.id)).toMatchObject({ position: 0, folderId: folder.id })
    expect(workspaceRows.find((row) => row.id === second.id)).toMatchObject({ position: 1, folderId: folder.id })
  })

  it('moves workspaces between folders and normalizes target sibling order', async () => {
    const { workspaceService } = await import('./service.js')
    const source = await workspaceService.createFolder({ name: 'Source' })
    const target = await workspaceService.createFolder({ name: 'Target' })
    const first = await workspaceService.create({ name: 'first', folderId: target.id })
    const moved = await workspaceService.create({ name: 'moved', folderId: source.id })
    const second = await workspaceService.create({ name: 'second', folderId: target.id })

    await workspaceService.moveSidebarNode({
      nodeType: 'workspace',
      nodeId: moved.id,
      parentFolderId: target.id,
      beforeNodeId: `workspace:${second.id}`,
    })

    expect(workspaceRows.find((row) => row.id === first.id)).toMatchObject({ folderId: target.id, position: 0 })
    expect(workspaceRows.find((row) => row.id === moved.id)).toMatchObject({ folderId: target.id, position: 1 })
    expect(workspaceRows.find((row) => row.id === second.id)).toMatchObject({ folderId: target.id, position: 2 })
  })

  it('deletes empty source folders after moving their last workspace', async () => {
    const { workspaceService } = await import('./service.js')
    const root = await workspaceService.createFolder({ name: 'Root' })
    const child = await workspaceService.createFolder({ name: 'Child', parentId: root.id })
    const target = await workspaceService.createFolder({ name: 'Target' })
    const moved = await workspaceService.create({ name: 'moved', folderId: child.id })

    await workspaceService.moveSidebarNode({
      nodeType: 'workspace',
      nodeId: moved.id,
      parentFolderId: target.id,
    })

    expect(folderRows.find((row) => row.id === child.id)).toBeUndefined()
    expect(folderRows.find((row) => row.id === root.id)).toBeUndefined()
    expect(folderRows.find((row) => row.id === target.id)).toBeDefined()
  })

  it('moves folders and rejects moving a folder into its own descendant', async () => {
    const { workspaceService } = await import('./service.js')
    const root = await workspaceService.createFolder({ name: 'Root' })
    const child = await workspaceService.createFolder({ name: 'Child', parentId: root.id })
    const target = await workspaceService.createFolder({ name: 'Target' })

    await expect(workspaceService.moveSidebarNode({
      nodeType: 'folder',
      nodeId: root.id,
      parentFolderId: child.id,
    })).rejects.toThrow(/descendant/i)

    await workspaceService.moveSidebarNode({ nodeType: 'folder', nodeId: child.id, parentFolderId: target.id })
    expect(folderRows.find((row) => row.id === child.id)).toMatchObject({ parentId: target.id, position: 0 })
  })

  it('archives a folder with all descendant folders and workspaces', async () => {
    const { workspaceService } = await import('./service.js')
    const root = await workspaceService.createFolder({ name: 'Root' })
    const child = await workspaceService.createFolder({ name: 'Child', parentId: root.id })
    const sibling = await workspaceService.createFolder({ name: 'Sibling' })
    const rootWorkspace = await workspaceService.create({ name: 'root workspace', folderId: root.id })
    const childWorkspace = await workspaceService.create({ name: 'child workspace', folderId: child.id })
    const siblingWorkspace = await workspaceService.create({ name: 'sibling workspace', folderId: sibling.id })

    await workspaceService.archiveFolder(root.id)

    expect(folderRows.find((row) => row.id === root.id)?.archivedAt).toBeInstanceOf(Date)
    expect(folderRows.find((row) => row.id === child.id)?.archivedAt).toBeInstanceOf(Date)
    expect(folderRows.find((row) => row.id === sibling.id)?.archivedAt).toBeNull()
    expect(workspaceRows.find((row) => row.id === rootWorkspace.id)?.archivedAt).toBeInstanceOf(Date)
    expect(workspaceRows.find((row) => row.id === childWorkspace.id)?.archivedAt).toBeInstanceOf(Date)
    expect(workspaceRows.find((row) => row.id === siblingWorkspace.id)?.archivedAt).toBeNull()
  })

  it('deletes empty parent folders after archiving their last workspace', async () => {
    const { workspaceService } = await import('./service.js')
    const root = await workspaceService.createFolder({ name: 'Root' })
    const child = await workspaceService.createFolder({ name: 'Child', parentId: root.id })
    const workspace = await workspaceService.create({ name: 'only workspace', folderId: child.id })

    await workspaceService.archive(workspace.id)

    expect(folderRows.find((row) => row.id === child.id)).toBeUndefined()
    expect(folderRows.find((row) => row.id === root.id)).toBeUndefined()
  })

  it('upserts and lists workspace resources', async () => {
    const { workspaceService } = await import('./service.js')
    const workspace = await workspaceService.create({ name: 'Resource workspace' })

    const first = await workspaceService.upsertResource(workspace.id, {
      type: 'browser_tab',
      resourceKey: 'browser-1',
      data: { browserTabId: 'browser-1' },
    })
    const second = await workspaceService.upsertResource(workspace.id, {
      type: 'browser_tab',
      resourceKey: 'browser-1',
      data: { browserTabId: 'browser-1', url: 'https://example.com' },
    })

    expect(second.id).toBe(first.id)
    await expect(workspaceService.listResources(workspace.id)).resolves.toMatchObject([
      { id: first.id, workspaceId: workspace.id, type: 'browser_tab', resourceKey: 'browser-1', shared: false, data: { url: 'https://example.com' } },
    ])
  })

  it('auto-renames folder-path workspaces from the first untitled chat prompt', async () => {
    const { workspaceService } = await import('./service.js')
    const workspace = await workspaceService.create({ name: 'project', nameSource: 'folder_path', sourceKind: 'folder', sourcePath: '/tmp/project' })

    const renamed = await workspaceService.maybeAutoNameFromPrompt({
      id: workspace.id,
      prompt: 'Add workspace folders to the sidebar and make ordering stable',
      isFirstChat: true,
      chatHadExplicitTitle: false,
    })

    expect(renamed).toMatchObject({ name: 'Add workspace folders to the sidebar and make ordering st…', nameSource: 'derived' })
  })

  it('does not auto-rename explicit, worktree, derived, or second-chat workspaces', async () => {
    const { workspaceService } = await import('./service.js')
    const explicit = await workspaceService.create({ name: 'Explicit', nameSource: 'explicit' })
    const worktree = await workspaceService.create({ name: 'feature-branch', nameSource: 'worktree' })
    const derived = await workspaceService.create({ name: 'Old derived', nameSource: 'derived' })
    const secondChat = await workspaceService.create({ name: 'project', nameSource: 'folder_path' })

    await workspaceService.maybeAutoNameFromPrompt({ id: explicit.id, prompt: 'Prompt title', isFirstChat: true, chatHadExplicitTitle: false })
    await workspaceService.maybeAutoNameFromPrompt({ id: worktree.id, prompt: 'Prompt title', isFirstChat: true, chatHadExplicitTitle: false })
    await workspaceService.maybeAutoNameFromPrompt({ id: derived.id, prompt: 'Prompt title', isFirstChat: true, chatHadExplicitTitle: false })
    await workspaceService.maybeAutoNameFromPrompt({ id: secondChat.id, prompt: 'Prompt title', isFirstChat: false, chatHadExplicitTitle: false })

    expect(workspaceRows.find((row) => row.id === explicit.id)).toMatchObject({ name: 'Explicit', nameSource: 'explicit' })
    expect(workspaceRows.find((row) => row.id === worktree.id)).toMatchObject({ name: 'feature-branch', nameSource: 'worktree' })
    expect(workspaceRows.find((row) => row.id === derived.id)).toMatchObject({ name: 'Old derived', nameSource: 'derived' })
    expect(workspaceRows.find((row) => row.id === secondChat.id)).toMatchObject({ name: 'project', nameSource: 'folder_path' })
  })
})

describe('workspace router', () => {
  it('validates git diff pane and tab contracts', async () => {
    const { paneContentSchema } = await import('../trpc/routers/agent-ui-schema.js')
    const { workspaceTabSchema } = await import('../trpc/routers/workspace.js')

    expect(paneContentSchema.parse({ type: 'git-diff', cwd: '/repo' })).toEqual({ type: 'git-diff', cwd: '/repo' })
    expect(workspaceTabSchema.parse({ id: 'diff-1', type: 'git-diff', envId: 'env-1', repoRoot: '/repo', title: 'Git Diff' })).toEqual({
      id: 'diff-1', type: 'git-diff', envId: 'env-1', repoRoot: '/repo', title: 'Git Diff',
    })
    expect(() => paneContentSchema.parse({ type: 'git-diff', cwd: '' })).toThrow()
    expect(() => workspaceTabSchema.parse({ id: 'diff-1', type: 'git-diff', envId: 'env-1', title: 'Git Diff' })).toThrow()
  })

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
      position: 2,
      tab: { id: 'tab-3', type: 'git-diff', envId: 'env-1', repoRoot: '/repo', title: 'Git Diff' },
    })
    await caller.upsertTab({
      workspaceId: workspace.id,
      position: 0,
      tab: { id: 'tab-1', type: 'browser', url: 'https://example.com', browserTabId: 'browser-1', title: 'Updated' },
    })

    await expect(caller.listTabs({ workspaceId: workspace.id })).resolves.toMatchObject([
      { id: 'tab-1', title: 'Updated', position: 0, browserTabId: 'browser-1' },
      { id: 'tab-2', title: 'Shell', position: 1, shellId: 'shell-1' },
      { id: 'tab-3', title: 'Git Diff', position: 2, repoRoot: '/repo' },
    ])

    await caller.deleteTab({ workspaceId: workspace.id, tabId: 'tab-1' })
    await expect(caller.listTabs({ workspaceId: workspace.id })).resolves.toMatchObject([
      { id: 'tab-2', title: 'Shell' },
      { id: 'tab-3', title: 'Git Diff', repoRoot: '/repo' },
    ])
  })

  it('opens a new backend-owned pane tab and activates it', async () => {
    const { workspaceService } = await import('./service.js')
    const workspace = await workspaceService.create({ name: 'Open pane workspace' })

    const opened = await workspaceService.openPane(workspace.id, {
      envId: 'env-1',
      content: { type: 'file', path: '/tmp/a.ts' },
      title: 'a.ts',
    })

    expect(tabRows).toHaveLength(1)
    expect(opened).toMatchObject({ type: 'file', envId: 'env-1', path: '/tmp/a.ts', position: 0 })
    expect(viewStateRows.find((row) => row.workspaceId === workspace.id)?.activeWorkspaceTabId).toBe(opened.id)
  })

  it('focuses an existing backend-owned pane tab without duplicating it', async () => {
    const { workspaceService } = await import('./service.js')
    const workspace = await workspaceService.create({ name: 'Duplicate pane workspace' })

    const first = await workspaceService.openPane(workspace.id, {
      envId: 'env-1',
      content: { type: 'file', path: '/tmp/a.ts' },
    })
    await workspaceService.openPane(workspace.id, {
      envId: 'env-1',
      content: { type: 'browser', url: 'https://example.com' },
    })
    const second = await workspaceService.openPane(workspace.id, {
      envId: 'env-1',
      content: { type: 'file', path: '/tmp/a.ts' },
    })

    expect(second.id).toBe(first.id)
    expect(tabRows).toHaveLength(2)
    expect(viewStateRows.find((row) => row.workspaceId === workspace.id)?.activeWorkspaceTabId).toBe(first.id)
  })

  it('deduplicates git diff panes by environment and repository root', async () => {
    const { workspaceService } = await import('./service.js')
    const workspace = await workspaceService.create({ name: 'Git diff pane workspace' })

    const first = await workspaceService.openPane(workspace.id, {
      envId: 'env-1',
      content: { type: 'git-diff', cwd: '/repo' },
    })
    const duplicate = await workspaceService.openPane(workspace.id, {
      envId: 'env-1',
      content: { type: 'git-diff', cwd: '/repo' },
    })
    await workspaceService.openPane(workspace.id, {
      envId: 'env-2',
      content: { type: 'git-diff', cwd: '/repo' },
    })
    await workspaceService.openPane(workspace.id, {
      envId: 'env-1',
      content: { type: 'git-diff', cwd: '/other' },
    })

    expect(duplicate.id).toBe(first.id)
    expect(tabRows.map((row) => [row.envId, row.repoRoot])).toEqual([
      ['env-1', '/repo'],
      ['env-2', '/repo'],
      ['env-1', '/other'],
    ])
  })

  it('opens a backend-owned pane tab without changing active tab when activate is false', async () => {
    const { workspaceService } = await import('./service.js')
    const workspace = await workspaceService.create({ name: 'Inactive pane workspace' })

    const active = await workspaceService.openPane(workspace.id, {
      envId: 'env-1',
      content: { type: 'shell', shellId: 'shell-1' },
    })
    const inactive = await workspaceService.openPane(workspace.id, {
      envId: 'env-1',
      content: { type: 'file', path: '/tmp/a.ts' },
      activate: false,
    })

    expect(inactive.id).not.toBe(active.id)
    expect(tabRows).toHaveLength(2)
    expect(viewStateRows.find((row) => row.workspaceId === workspace.id)?.activeWorkspaceTabId).toBe(active.id)
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

describe('env api router', () => {
  it('accepts an identity token and persists a file pane tab', async () => {
    const { workspaceService } = await import('./service.js')
    const { envApiRouter } = await import('../trpc/routers/env-api.js')
    const workspace = await workspaceService.create({ name: 'Env API workspace' })
    const caller = envApiRouter.createCaller(makeIdentityCtx())

    const result = await caller.openPane({
      workspaceId: workspace.id,
      envId: 'local-default',
      content: { type: 'file', path: '/tmp/a.ts' },
      title: 'a.ts',
    })

    expect(result.ok).toBe(true)
    expect(tabRows).toHaveLength(1)
    expect(tabRows[0]).toMatchObject({ workspaceId: workspace.id, type: 'file', envId: 'local-default', path: '/tmp/a.ts' })
  })

  it('returns a typed error for a missing workspace', async () => {
    const { envApiRouter } = await import('../trpc/routers/env-api.js')
    const caller = envApiRouter.createCaller(makeIdentityCtx())

    await expect(caller.openPane({
      workspaceId: 'missing-workspace',
      envId: 'local-default',
      content: { type: 'file', path: '/tmp/a.ts' },
    })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('persists and activates a pane with no frontend subscriber, then exposes it through workspace reads', async () => {
    const { workspaceService } = await import('./service.js')
    const { envApiRouter } = await import('../trpc/routers/env-api.js')
    const workspace = await workspaceService.create({ name: 'No frontend workspace' })
    const caller = envApiRouter.createCaller(makeIdentityCtx())

    const result = await caller.openPane({
      workspaceId: workspace.id,
      envId: 'local-default',
      content: { type: 'file', path: '/tmp/no-frontend.ts' },
    })
    const tabs = await workspaceService.listTabs(workspace.id)
    const viewState = await workspaceService.getViewState(workspace.id)

    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ type: 'file', envId: 'local-default', path: '/tmp/no-frontend.ts' })
    expect(viewState.activeWorkspaceTabId).toBe(result.tab.id)
  })

  it('persists shell and browser panes from env API with correct identity fields', async () => {
    const { workspaceService } = await import('./service.js')
    const { envApiRouter } = await import('../trpc/routers/env-api.js')
    const workspace = await workspaceService.create({ name: 'Pane types workspace' })
    const caller = envApiRouter.createCaller(makeIdentityCtx())

    await caller.openPane({
      workspaceId: workspace.id,
      envId: 'local-default',
      content: { type: 'shell', shellId: 'shell-1' },
    })
    await caller.openPane({
      workspaceId: workspace.id,
      envId: 'local-default',
      content: { type: 'browser', url: 'https://example.com', browserTabId: 'native-1' },
    })

    await expect(workspaceService.listTabs(workspace.id)).resolves.toMatchObject([
      { type: 'shell', envId: 'local-default', shellId: 'shell-1', position: 0 },
      { type: 'browser', url: 'https://example.com', browserTabId: 'native-1', position: 1 },
    ])
  })
})
