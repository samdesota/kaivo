import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { workspaceTabFromPaneContent, workspaceTabKey, type PaneContent } from '../../shared/workspace-pane'
import { db, type Db } from '../db/client.js'
import {
  agentNotifications,
  workspaceAgentTabs,
  workspaceFolders,
  workspaceResources,
  workspaceTabs,
  workspaceUiStates,
  workspaceViewStates,
  workspaces,
  type WorkspaceTab,
  type WorkspaceTabRow,
  type WorkspaceAgentTabRow,
  type AgentNotificationRow,
  type WorkspaceUiState,
  type WorkspaceViewState,
  type WorkspaceResourceRow,
  type WorkspaceResourceType,
  type WorkspaceSystemKey,
} from '../db/schema.js'

export type Workspace = typeof workspaces.$inferSelect
export type WorkspaceFolder = typeof workspaceFolders.$inferSelect

export const GLOBAL_TABS_SYSTEM_WORKSPACE_KEY = 'global-tabs' satisfies WorkspaceSystemKey
export const GLOBAL_TABS_SYSTEM_WORKSPACE_NAME = 'Global tabs'

export type WorkspaceSidebarNode =
  | { type: 'folder'; folder: WorkspaceFolder; children: WorkspaceSidebarNode[] }
  | { type: 'workspace'; workspace: Workspace }

export type WorkspaceSidebarNodeKind = 'folder' | 'workspace'

export class WorkspaceError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_name' | 'invalid_pane',
    message: string,
  ) {
    super(message)
  }
}

function isHiddenSystemWorkspace(workspace: Workspace): boolean {
  return workspace.kind === 'system' || workspace.hidden
}

function assertMutableWorkspace(workspace: Workspace): void {
  if (workspace.protected || workspace.kind === 'system') {
    throw new WorkspaceError('invalid_name', 'system workspace cannot be modified')
  }
}

export const EMPTY_WORKSPACE_UI_STATE: WorkspaceUiState = {
  activeAgentSessionId: null,
  activeWorkspaceTabId: null,
  workspaceTabs: [],
  splitRatio: null,
  agentCollapsed: false,
  tabOrder: [],
}

export type WorkspaceViewStateInput = {
  activeAgentSessionId?: string | null
  activeWorkspaceTabId?: string | null
  splitRatio?: number | null
  agentCollapsed?: boolean
}

function isNoopViewStatePatch(current: WorkspaceViewState, patch: WorkspaceViewStateInput): boolean {
  return Object.entries(patch).every(([key, value]) => Object.is(current[key as keyof WorkspaceViewState], value))
}

export type WorkspaceTabInput = {
  tab: WorkspaceTab
  position: number
}

export type WorkspaceOpenPaneInput = {
  envId: string
  content: PaneContent
  title?: string
  activate?: boolean
}

export type WorkspaceAgentTabInput = {
  sessionId: string
  position: number
}

export type AgentNotificationInput = {
  workspaceId: string
  sessionId: string
  kind?: AgentNotificationRow['kind']
  title: string
  summary: string
}

export type WorkspaceResourceInput = {
  type: WorkspaceResourceType
  resourceKey: string
  shared?: boolean
  data?: Record<string, unknown>
}

function emptyWorkspaceViewState(workspaceId: string, updatedAt = new Date()): WorkspaceViewState {
  return {
    workspaceId,
    activeAgentSessionId: null,
    activeWorkspaceTabId: null,
    splitRatio: null,
    agentCollapsed: false,
    updatedAt,
  }
}

function normalizeWorkspaceUiState(state: WorkspaceUiState): WorkspaceUiState {
  const workspaceTabs = Array.isArray(state.workspaceTabs) ? state.workspaceTabs : []
  const activeWorkspaceTabId = workspaceTabs.some((tab) => tab.id === state.activeWorkspaceTabId)
    ? state.activeWorkspaceTabId
    : (workspaceTabs[0]?.id ?? null)
  return {
    ...EMPTY_WORKSPACE_UI_STATE,
    ...state,
    activeAgentSessionId: state.activeAgentSessionId ?? null,
    activeWorkspaceTabId,
    workspaceTabs,
    agentCollapsed: state.agentCollapsed ?? false,
    tabOrder: workspaceTabs.map((tab) => tab.id),
  }
}

export function tabToRow(workspaceId: string, tab: WorkspaceTab, position: number, updatedAt: Date): WorkspaceTabRow {
  return {
    workspaceId,
    id: tab.id,
    type: tab.type,
    title: tab.title,
    titleSource: tab.type === 'shell' ? (tab.titleSource ?? 'auto') : null,
    position,
    envId: 'envId' in tab ? tab.envId : null,
    shellId: tab.type === 'shell' ? tab.shellId : null,
    path: tab.type === 'file' ? tab.path : null,
    repoRoot: tab.type === 'git-diff' ? tab.repoRoot : null,
    sessionId: tab.type === 'file' ? (tab.sessionId ?? null) : null,
    port: null,
    url: tab.type === 'browser' ? tab.url : null,
    browserTabId: tab.type === 'browser' ? (tab.browserTabId ?? null) : null,
    faviconUrl: tab.type === 'browser' ? (tab.faviconUrl ?? null) : null,
    updatedAt,
  }
}

export function sameWorkspaceTabRow(left: WorkspaceTabRow, right: WorkspaceTabRow): boolean {
  return left.workspaceId === right.workspaceId
    && left.id === right.id
    && left.type === right.type
    && left.title === right.title
    && left.titleSource === right.titleSource
    && left.position === right.position
    && left.envId === right.envId
    && left.shellId === right.shellId
    && left.path === right.path
    && left.repoRoot === right.repoRoot
    && left.sessionId === right.sessionId
    && left.port === right.port
    && left.url === right.url
    && left.browserTabId === right.browserTabId
    && left.faviconUrl === right.faviconUrl
}

function sameWorkspaceViewStateValues(left: WorkspaceViewState, right: Pick<WorkspaceViewState, 'activeAgentSessionId' | 'activeWorkspaceTabId' | 'splitRatio' | 'agentCollapsed'>): boolean {
  return left.activeAgentSessionId === right.activeAgentSessionId
    && left.activeWorkspaceTabId === right.activeWorkspaceTabId
    && Object.is(left.splitRatio, right.splitRatio)
    && left.agentCollapsed === right.agentCollapsed
}

export function rowToTab(row: WorkspaceTabRow): WorkspaceTab | null {
  if (row.type === 'shell' && row.envId && row.shellId) {
    return { id: row.id, type: 'shell', envId: row.envId, shellId: row.shellId, title: row.title, titleSource: row.titleSource ?? 'auto' }
  }
  if (row.type === 'file' && row.envId && row.path) {
    return { id: row.id, type: 'file', envId: row.envId, path: row.path, sessionId: row.sessionId ?? undefined, title: row.title }
  }
  if (row.type === 'git-diff' && row.envId && row.repoRoot) {
    return { id: row.id, type: 'git-diff', envId: row.envId, repoRoot: row.repoRoot, title: row.title }
  }
  if (row.type === 'browser' && row.url) {
    return { id: row.id, type: 'browser', url: row.url, browserTabId: row.browserTabId ?? undefined, faviconUrl: row.faviconUrl ?? undefined, title: row.title }
  }
  return null
}

export function normalizeWorkspaceName(name: string | undefined): string {
  const trimmed = (name ?? '').trim()
  return trimmed || 'Untitled workspace'
}

export function promptTitle(input: string): string {
  const flat = input.replace(/\s+/g, ' ').trim()
  if (flat.length <= 60) return flat
  return flat.slice(0, 57).replace(/[\s.,;:!?-]+$/, '') + '…'
}

function siblingParentId(parentId?: string | null): string | null {
  return parentId ?? null
}

function sameParent(rowParentId: string | null | undefined, parentId: string | null): boolean {
  return (rowParentId ?? null) === parentId
}

function sortByPosition<T extends { position: number; createdAt: Date; id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.position !== b.position) return a.position - b.position
    const created = a.createdAt.getTime() - b.createdAt.getTime()
    if (created !== 0) return created
    return a.id.localeCompare(b.id)
  })
}

function parseMoveBeforeNodeId(beforeNodeId?: string | null): { kind: WorkspaceSidebarNodeKind; id: string } | null {
  if (!beforeNodeId) return null
  const [kind, ...rest] = beforeNodeId.split(':')
  if ((kind !== 'folder' && kind !== 'workspace') || rest.length === 0) return null
  return { kind, id: rest.join(':') }
}

function folderDescendantIds(folders: WorkspaceFolder[], folderId: string): Set<string> {
  const out = new Set<string>()
  function visit(parentId: string) {
    for (const folder of folders) {
      if ((folder.parentId ?? null) !== parentId || out.has(folder.id)) continue
      out.add(folder.id)
      visit(folder.id)
    }
  }
  visit(folderId)
  return out
}

export function createWorkspaceService(database: Db = db) {
  async function get(id: string): Promise<Workspace> {
    const rows = await database
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1)
    const row = rows[0]
    if (!row || row.archivedAt) {
      throw new WorkspaceError('not_found', 'workspace not found')
    }
    return row
  }

  async function getFolder(id: string): Promise<WorkspaceFolder> {
    const rows = await database
      .select()
      .from(workspaceFolders)
      .where(eq(workspaceFolders.id, id))
      .limit(1)
    const row = rows[0]
    if (!row || row.archivedAt) {
      throw new WorkspaceError('not_found', 'workspace folder not found')
    }
    return row
  }

  async function listActiveFolders(): Promise<WorkspaceFolder[]> {
    return await database
      .select()
      .from(workspaceFolders)
      .where(isNull(workspaceFolders.archivedAt))
      .orderBy(asc(workspaceFolders.position), asc(workspaceFolders.createdAt), asc(workspaceFolders.id))
  }

  async function listActiveWorkspaces(input?: { includeSystem?: boolean }): Promise<Workspace[]> {
    const rows = await database
      .select()
      .from(workspaces)
      .where(isNull(workspaces.archivedAt))
      .orderBy(asc(workspaces.position), asc(workspaces.createdAt), asc(workspaces.id))
    return input?.includeSystem ? rows : rows.filter((workspace) => !isHiddenSystemWorkspace(workspace))
  }

  async function getSystemWorkspace(systemKey: WorkspaceSystemKey): Promise<Workspace | null> {
    const rows = await database
      .select()
      .from(workspaces)
      .where(eq(workspaces.systemKey, systemKey))
      .limit(1)
    const row = rows[0]
    return row && !row.archivedAt ? row : null
  }

  async function getOrCreateGlobalTabsWorkspace(): Promise<Workspace> {
    const existing = await getSystemWorkspace(GLOBAL_TABS_SYSTEM_WORKSPACE_KEY)
    if (existing) return existing
    const id = ulid()
    const now = new Date()
    const row: Workspace = {
      id,
      name: GLOBAL_TABS_SYSTEM_WORKSPACE_NAME,
      folderId: null,
      position: 0,
      nameSource: 'explicit',
      sourceKind: null,
      sourcePath: null,
      kind: 'system',
      systemKey: GLOBAL_TABS_SYSTEM_WORKSPACE_KEY,
      hidden: true,
      protected: true,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: null,
      archivedAt: null,
    }
    await database.insert(workspaces).values(row)
    await database.insert(workspaceViewStates).values(emptyWorkspaceViewState(id, now))
    return row
  }

  async function nextSiblingPosition(parentId?: string | null): Promise<number> {
    const normalizedParentId = siblingParentId(parentId)
    const [folders, workspaceRows] = await Promise.all([listActiveFolders(), listActiveWorkspaces()])
    const positions = [
      ...folders.filter((folder) => sameParent(folder.parentId, normalizedParentId)).map((folder) => folder.position),
      ...workspaceRows.filter((workspace) => sameParent(workspace.folderId, normalizedParentId)).map((workspace) => workspace.position),
    ]
    return positions.length === 0 ? 0 : Math.max(...positions) + 1
  }

  async function assertFolderParent(parentId?: string | null): Promise<string | null> {
    const normalizedParentId = siblingParentId(parentId)
    if (normalizedParentId) await getFolder(normalizedParentId)
    return normalizedParentId
  }

  async function listTree(): Promise<WorkspaceSidebarNode[]> {
    const [folders, workspaceRows] = await Promise.all([listActiveFolders(), listActiveWorkspaces()])
    const folderNodes = new Map<string, Extract<WorkspaceSidebarNode, { type: 'folder' }>>()
    for (const folder of folders) {
      folderNodes.set(folder.id, { type: 'folder', folder, children: [] })
    }
    const roots: WorkspaceSidebarNode[] = []
    for (const folder of sortByPosition(folders)) {
      const node = folderNodes.get(folder.id)
      if (!node) continue
      const parentNode = folder.parentId ? folderNodes.get(folder.parentId) : null
      if (parentNode) parentNode.children.push(node)
      else roots.push(node)
    }
    for (const workspace of sortByPosition(workspaceRows)) {
      const node: WorkspaceSidebarNode = { type: 'workspace', workspace }
      const parentNode = workspace.folderId ? folderNodes.get(workspace.folderId) : null
      if (parentNode) parentNode.children.push(node)
      else roots.push(node)
    }
    const sortNodes = (nodes: WorkspaceSidebarNode[]) => {
      nodes.sort((a, b) => {
        const aRow = a.type === 'folder' ? a.folder : a.workspace
        const bRow = b.type === 'folder' ? b.folder : b.workspace
        if (aRow.position !== bRow.position) return aRow.position - bRow.position
        const created = aRow.createdAt.getTime() - bRow.createdAt.getTime()
        if (created !== 0) return created
        return aRow.id.localeCompare(bRow.id)
      })
      for (const node of nodes) {
        if (node.type === 'folder') sortNodes(node.children)
      }
    }
    sortNodes(roots)
    return roots
  }

  async function moveSidebarNode(input: {
    nodeType: WorkspaceSidebarNodeKind
    nodeId: string
    parentFolderId?: string | null
    beforeNodeId?: string | null
  }): Promise<WorkspaceSidebarNode[]> {
    const parentFolderId = await assertFolderParent(input.parentFolderId)
    let previousParentId: string | null = null
    if (input.nodeType === 'folder') {
      const moving = await getFolder(input.nodeId)
      previousParentId = moving.parentId ?? null
      if (parentFolderId === moving.id) throw new WorkspaceError('invalid_name', 'cannot move folder into itself')
      if (parentFolderId) {
        const descendants = folderDescendantIds(await listActiveFolders(), moving.id)
        if (descendants.has(parentFolderId)) throw new WorkspaceError('invalid_name', 'cannot move folder into its descendant')
      }
    } else {
      const moving = await get(input.nodeId)
      assertMutableWorkspace(moving)
      previousParentId = moving.folderId ?? null
    }

    const before = parseMoveBeforeNodeId(input.beforeNodeId)
    if (before) {
      if (before.kind === 'folder') {
        const row = await getFolder(before.id)
        if ((row.parentId ?? null) !== parentFolderId) throw new WorkspaceError('invalid_name', 'before folder is not in target parent')
      } else {
        const row = await get(before.id)
        if (isHiddenSystemWorkspace(row)) throw new WorkspaceError('invalid_name', 'before workspace is not in target parent')
        if ((row.folderId ?? null) !== parentFolderId) throw new WorkspaceError('invalid_name', 'before workspace is not in target parent')
      }
    }

    const [folders, workspaceRows] = await Promise.all([listActiveFolders(), listActiveWorkspaces()])
    type Sibling = { kind: WorkspaceSidebarNodeKind; id: string; createdAt: Date; position: number }
    const siblings: Sibling[] = [
      ...folders
        .filter((folder) => sameParent(folder.parentId, parentFolderId))
        .map((folder) => ({ kind: 'folder' as const, id: folder.id, createdAt: folder.createdAt, position: folder.position })),
      ...workspaceRows
        .filter((workspace) => sameParent(workspace.folderId, parentFolderId))
        .map((workspace) => ({ kind: 'workspace' as const, id: workspace.id, createdAt: workspace.createdAt, position: workspace.position })),
    ].filter((row) => !(row.kind === input.nodeType && row.id === input.nodeId))
    siblings.sort((a, b) => {
      if (a.position !== b.position) return a.position - b.position
      const created = a.createdAt.getTime() - b.createdAt.getTime()
      if (created !== 0) return created
      return `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)
    })
    const movingSibling: Sibling = {
      kind: input.nodeType,
      id: input.nodeId,
      createdAt: new Date(),
      position: -1,
    }
    const beforeIndex = before ? siblings.findIndex((row) => row.kind === before.kind && row.id === before.id) : -1
    if (before && beforeIndex < 0) throw new WorkspaceError('invalid_name', 'before node not found')
    siblings.splice(before ? beforeIndex : siblings.length, 0, movingSibling)

    const now = new Date()
    if (input.nodeType === 'folder') {
      await database
        .update(workspaceFolders)
        .set({ parentId: parentFolderId, updatedAt: now })
        .where(eq(workspaceFolders.id, input.nodeId))
    } else {
      await database
        .update(workspaces)
        .set({ folderId: parentFolderId, updatedAt: now })
        .where(eq(workspaces.id, input.nodeId))
    }
    for (let position = 0; position < siblings.length; position++) {
      const row = siblings[position]!
      if (row.kind === 'folder') {
        await database.update(workspaceFolders).set({ position, updatedAt: now }).where(eq(workspaceFolders.id, row.id))
      } else {
        await database.update(workspaces).set({ position, updatedAt: now }).where(eq(workspaces.id, row.id))
      }
    }
    if (previousParentId && previousParentId !== parentFolderId) await deleteEmptyFolderAncestors(previousParentId)
    return await listTree()
  }

  async function deleteEmptyFolderAncestors(startFolderId: string | null): Promise<void> {
    let folderId = startFolderId
    while (folderId) {
      const folders = await listActiveFolders()
      const folder = folders.find((row) => row.id === folderId)
      if (!folder) return
      const workspaceRows = await listActiveWorkspaces({ includeSystem: true })
      const hasChildFolder = folders.some((row) => (row.parentId ?? null) === folderId)
      const hasWorkspace = workspaceRows.some((row) => (row.folderId ?? null) === folderId)
      if (hasChildFolder || hasWorkspace) return
      await database.delete(workspaceFolders).where(eq(workspaceFolders.id, folderId))
      folderId = folder.parentId ?? null
    }
  }

  async function getUiState(workspaceId: string): Promise<WorkspaceUiState> {
    await get(workspaceId)
    const viewRows = await database
      .select()
      .from(workspaceViewStates)
      .where(eq(workspaceViewStates.workspaceId, workspaceId))
      .limit(1)
    if (!viewRows[0]) {
      const legacyRows = await database
        .select()
        .from(workspaceUiStates)
        .where(eq(workspaceUiStates.workspaceId, workspaceId))
        .limit(1)
      return legacyRows[0]?.state ? normalizeWorkspaceUiState(legacyRows[0].state) : EMPTY_WORKSPACE_UI_STATE
    }
    const tabRows = await database
      .select()
      .from(workspaceTabs)
      .where(eq(workspaceTabs.workspaceId, workspaceId))
      .orderBy(asc(workspaceTabs.position))
    return normalizeWorkspaceUiState({
      activeAgentSessionId: viewRows[0].activeAgentSessionId,
      activeWorkspaceTabId: viewRows[0].activeWorkspaceTabId,
      workspaceTabs: tabRows.map(rowToTab).filter((tab): tab is WorkspaceTab => Boolean(tab)),
      splitRatio: viewRows[0].splitRatio,
      agentCollapsed: viewRows[0].agentCollapsed,
      tabOrder: [],
    })
  }

  async function getViewState(workspaceId: string): Promise<WorkspaceViewState> {
    await get(workspaceId)
    const rows = await database
      .select()
      .from(workspaceViewStates)
      .where(eq(workspaceViewStates.workspaceId, workspaceId))
      .limit(1)
    if (rows[0]) return rows[0]
    const legacy = await getUiState(workspaceId)
    return {
      ...emptyWorkspaceViewState(workspaceId),
      activeAgentSessionId: legacy.activeAgentSessionId,
      activeWorkspaceTabId: legacy.activeWorkspaceTabId,
      splitRatio: legacy.splitRatio,
      agentCollapsed: legacy.agentCollapsed,
    }
  }

  async function saveViewState(workspaceId: string, state: WorkspaceViewStateInput): Promise<WorkspaceViewState> {
    const current = await getViewState(workspaceId)
    if (isNoopViewStatePatch(current, state)) return current
    const now = new Date()
    const next: WorkspaceViewState = {
      ...current,
      ...state,
      workspaceId,
      updatedAt: now,
    }
    await database
      .insert(workspaceViewStates)
      .values(next)
      .onConflictDoUpdate({
        target: workspaceViewStates.workspaceId,
        set: {
          activeAgentSessionId: next.activeAgentSessionId,
          activeWorkspaceTabId: next.activeWorkspaceTabId,
          splitRatio: next.splitRatio,
          agentCollapsed: next.agentCollapsed,
          updatedAt: next.updatedAt,
        },
      })
    return next
  }

  async function listTabs(workspaceId: string): Promise<WorkspaceTabRow[]> {
    await get(workspaceId)
    return await database
      .select()
      .from(workspaceTabs)
      .where(eq(workspaceTabs.workspaceId, workspaceId))
      .orderBy(asc(workspaceTabs.position), asc(workspaceTabs.id))
  }

  async function upsertTab(workspaceId: string, input: WorkspaceTabInput): Promise<WorkspaceTabRow> {
    await get(workspaceId)
    const now = new Date()
    const row = tabToRow(workspaceId, input.tab, input.position, now)
    const existing = await database
      .select()
      .from(workspaceTabs)
      .where(and(eq(workspaceTabs.workspaceId, workspaceId), eq(workspaceTabs.id, input.tab.id)))
      .limit(1)
    if (existing[0] && sameWorkspaceTabRow(existing[0], row)) return existing[0]
    await database
      .insert(workspaceTabs)
      .values(row)
      .onConflictDoUpdate({
        target: [workspaceTabs.workspaceId, workspaceTabs.id],
        set: {
          type: sql`excluded.type`,
          title: sql`excluded.title`,
          titleSource: sql`excluded.title_source`,
          position: sql`excluded.position`,
          envId: sql`excluded.env_id`,
          shellId: sql`excluded.shell_id`,
          path: sql`excluded.path`,
          repoRoot: sql`excluded.repo_root`,
          sessionId: sql`excluded.session_id`,
          port: sql`excluded.port`,
          url: sql`excluded.url`,
          browserTabId: sql`excluded.browser_tab_id`,
          faviconUrl: sql`excluded.favicon_url`,
          updatedAt: sql`excluded.updated_at`,
        },
      })
    const rows = await database
      .select()
      .from(workspaceTabs)
      .where(eq(workspaceTabs.workspaceId, workspaceId))
      .orderBy(asc(workspaceTabs.position), asc(workspaceTabs.id))
    return rows.find((tab) => tab.id === input.tab.id) ?? row
  }

  async function openPane(workspaceId: string, input: WorkspaceOpenPaneInput): Promise<WorkspaceTabRow> {
    await get(workspaceId)
    const tab = workspaceTabFromPaneContent(input.content, input.envId, { title: input.title })
    if (!tab) throw new WorkspaceError('invalid_pane', 'pane content cannot be opened in a workspace')

    const rows = await listTabs(workspaceId)
    const key = workspaceTabKey(tab)
    const existing = rows.find((row) => {
      const current = rowToTab(row)
      return current ? workspaceTabKey(current) === key : false
    })
    const opened = existing ?? (await upsertTab(workspaceId, {
      tab,
      position: rows.reduce((max, row) => Math.max(max, row.position), -1) + 1,
    }))

    if (input.activate !== false) {
      await saveViewState(workspaceId, { activeWorkspaceTabId: opened.id })
    }
    return opened
  }

  async function deleteTab(workspaceId: string, tabId: string): Promise<void> {
    await get(workspaceId)
    await database.delete(workspaceTabs).where(and(eq(workspaceTabs.workspaceId, workspaceId), eq(workspaceTabs.id, tabId)))
  }

  async function listAgentTabs(workspaceId: string): Promise<WorkspaceAgentTabRow[]> {
    await get(workspaceId)
    return await database
      .select()
      .from(workspaceAgentTabs)
      .where(eq(workspaceAgentTabs.workspaceId, workspaceId))
      .orderBy(asc(workspaceAgentTabs.position), asc(workspaceAgentTabs.sessionId))
  }

  async function upsertAgentTab(workspaceId: string, input: WorkspaceAgentTabInput): Promise<WorkspaceAgentTabRow> {
    await get(workspaceId)
    const now = new Date()
    const row = { workspaceId, sessionId: input.sessionId, position: input.position, updatedAt: now }
    await database
      .insert(workspaceAgentTabs)
      .values(row)
      .onConflictDoUpdate({
        target: [workspaceAgentTabs.workspaceId, workspaceAgentTabs.sessionId],
        set: {
          position: input.position,
          updatedAt: now,
        },
      })
    return row
  }

  async function deleteAgentTab(workspaceId: string, sessionId: string): Promise<void> {
    await get(workspaceId)
    await database
      .delete(workspaceAgentTabs)
      .where(and(eq(workspaceAgentTabs.workspaceId, workspaceId), eq(workspaceAgentTabs.sessionId, sessionId)))
  }

  async function listResources(workspaceId?: string): Promise<WorkspaceResourceRow[]> {
    const rows = workspaceId
      ? await database.select().from(workspaceResources).where(eq(workspaceResources.workspaceId, workspaceId)).orderBy(asc(workspaceResources.createdAt), asc(workspaceResources.id))
      : await database.select().from(workspaceResources).orderBy(asc(workspaceResources.createdAt), asc(workspaceResources.id))
    return rows as WorkspaceResourceRow[]
  }

  async function upsertResource(workspaceId: string, input: WorkspaceResourceInput): Promise<WorkspaceResourceRow> {
    await get(workspaceId)
    const resourceKey = input.resourceKey.trim()
    if (!resourceKey) throw new WorkspaceError('invalid_name', 'workspace resource key is required')
    const now = new Date()
    const existing = (await listResources(workspaceId)).find((resource) => resource.type === input.type && resource.resourceKey === resourceKey)
    if (existing) {
      const rows = await database
        .update(workspaceResources)
        .set({
          shared: input.shared ?? existing.shared,
          data: input.data ?? existing.data,
          updatedAt: now,
        })
        .where(eq(workspaceResources.id, existing.id))
        .returning()
      return (rows[0] as WorkspaceResourceRow | undefined) ?? { ...existing, shared: input.shared ?? existing.shared, data: input.data ?? existing.data, updatedAt: now }
    }
    const row: WorkspaceResourceRow = {
      id: ulid().toLowerCase(),
      workspaceId,
      type: input.type,
      resourceKey,
      shared: input.shared ?? false,
      data: input.data ?? {},
      createdAt: now,
      updatedAt: now,
    }
    await database.insert(workspaceResources).values(row)
    return row
  }

  async function deleteResource(id: string): Promise<void> {
    await database.delete(workspaceResources).where(eq(workspaceResources.id, id))
  }

  async function createAgentNotification(input: AgentNotificationInput): Promise<AgentNotificationRow> {
    await get(input.workspaceId)
    const row: AgentNotificationRow = {
      id: ulid().toLowerCase(),
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      kind: input.kind ?? 'finished',
      title: input.title.trim().slice(0, 120) || 'Chat finished',
      summary: input.summary.trim().slice(0, 120) || 'Chat finished',
      createdAt: new Date(),
    }
    await database.insert(agentNotifications).values(row)
    return row
  }

  async function dismissAgentNotification(id: string): Promise<void> {
    await database.delete(agentNotifications).where(eq(agentNotifications.id, id))
  }

  async function dismissAgentNotificationsForSession(sessionId: string): Promise<void> {
    await database.delete(agentNotifications).where(eq(agentNotifications.sessionId, sessionId))
  }

  return {
    async list(): Promise<Workspace[]> {
      const rows = await listActiveWorkspaces()
      return sortByPosition(rows)
    },

    listTree,

    moveSidebarNode,

    getFolder,

    async createFolder(input: { name: string; parentId?: string | null }): Promise<WorkspaceFolder> {
      const name = input.name.trim()
      if (!name) throw new WorkspaceError('invalid_name', 'workspace folder name is required')
      const parentId = await assertFolderParent(input.parentId)
      const id = ulid()
      const now = new Date()
      const row: WorkspaceFolder = {
        id,
        parentId,
        name,
        position: await nextSiblingPosition(parentId),
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      }
      await database.insert(workspaceFolders).values(row)
      return row
    },

    async renameFolder(id: string, name: string): Promise<WorkspaceFolder> {
      const nextName = name.trim()
      if (!nextName) throw new WorkspaceError('invalid_name', 'workspace folder name is required')
      await getFolder(id)
      const now = new Date()
      const rows = await database
        .update(workspaceFolders)
        .set({ name: nextName, updatedAt: now })
        .where(eq(workspaceFolders.id, id))
        .returning()
      return rows[0] ?? (await getFolder(id))
    },

    async archiveFolder(id: string): Promise<void> {
      const folder = await getFolder(id)
      const now = new Date()
      const folders = await listActiveFolders()
      const folderIds = new Set([id, ...folderDescendantIds(folders, id)])
      const workspaceRows = await listActiveWorkspaces({ includeSystem: true })
      const workspacesToArchive = workspaceRows.filter((workspace) => workspace.folderId && folderIds.has(workspace.folderId))
      for (const workspace of workspacesToArchive) assertMutableWorkspace(workspace)
      for (const folderId of folderIds) {
        await database
          .update(workspaceFolders)
          .set({ archivedAt: now, updatedAt: now })
          .where(eq(workspaceFolders.id, folderId))
      }
      for (const workspace of workspacesToArchive) {
        await database
          .update(workspaces)
          .set({ archivedAt: now, updatedAt: now })
          .where(eq(workspaces.id, workspace.id))
      }
      await deleteEmptyFolderAncestors(folder.parentId ?? null)
    },

    async setFolderCollapsed(id: string, collapsed: boolean): Promise<WorkspaceFolder> {
      await getFolder(id)
      const now = new Date()
      const rows = await database
        .update(workspaceFolders)
        .set({ collapsed, updatedAt: now })
        .where(eq(workspaceFolders.id, id))
        .returning()
      return rows[0] ?? (await getFolder(id))
    },

    get,

    getOrCreateGlobalTabsWorkspace,

    async create(input?: {
      name?: string
      folderId?: string | null
      nameSource?: Workspace['nameSource']
      sourceKind?: Workspace['sourceKind']
      sourcePath?: string | null
    }): Promise<Workspace> {
      const id = ulid()
      const now = new Date()
      const folderId = await assertFolderParent(input?.folderId)
      const row: Workspace = {
        id,
        name: normalizeWorkspaceName(input?.name),
        folderId,
        position: await nextSiblingPosition(folderId),
        nameSource: input?.nameSource ?? 'explicit',
        sourceKind: input?.sourceKind ?? null,
        sourcePath: input?.sourcePath ?? null,
        kind: 'user',
        systemKey: null,
        hidden: false,
        protected: false,
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
        archivedAt: null,
      }
      await database.insert(workspaces).values(row)
      await database.insert(workspaceViewStates).values({
        workspaceId: id,
        activeAgentSessionId: null,
        activeWorkspaceTabId: null,
        splitRatio: null,
        agentCollapsed: false,
        updatedAt: now,
      })
      return row
    },

    async rename(id: string, name: string): Promise<Workspace> {
      const nextName = name.trim()
      if (!nextName) throw new WorkspaceError('invalid_name', 'workspace name is required')
      assertMutableWorkspace(await get(id))
      const now = new Date()
      const rows = await database
        .update(workspaces)
        .set({ name: nextName, nameSource: 'explicit', updatedAt: now })
        .where(eq(workspaces.id, id))
        .returning()
      return rows[0] ?? (await get(id))
    },

    async maybeAutoNameFromPrompt(input: {
      id: string
      prompt: string
      isFirstChat: boolean
      chatHadExplicitTitle: boolean
    }): Promise<Workspace> {
      const current = await get(input.id)
      if (
        current.nameSource !== 'folder_path' ||
        !input.isFirstChat ||
        input.chatHadExplicitTitle
      ) {
        return current
      }
      const title = promptTitle(input.prompt)
      if (!title) return current
      const now = new Date()
      const rows = await database
        .update(workspaces)
        .set({ name: title, nameSource: 'derived', updatedAt: now })
        .where(eq(workspaces.id, input.id))
        .returning()
      return rows[0] ?? (await get(input.id))
    },

    async archive(id: string): Promise<void> {
      const workspace = await get(id)
      assertMutableWorkspace(workspace)
      const now = new Date()
      await database
        .update(workspaces)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(workspaces.id, id))
      await deleteEmptyFolderAncestors(workspace.folderId ?? null)
    },

    async markOpened(id: string): Promise<Workspace> {
      await get(id)
      const now = new Date()
      const rows = await database
        .update(workspaces)
        .set({ lastOpenedAt: now, updatedAt: now })
        .where(eq(workspaces.id, id))
        .returning()
      return rows[0] ?? (await get(id))
    },

    getUiState,

    getViewState,

    saveViewState,

    listTabs,

    upsertTab,

    openPane,

    deleteTab,

    listAgentTabs,

    upsertAgentTab,

    deleteAgentTab,

    listResources,

    upsertResource,

    deleteResource,

    createAgentNotification,

    dismissAgentNotification,

    dismissAgentNotificationsForSession,

    async saveUiState(workspaceId: string, state: WorkspaceUiState): Promise<WorkspaceUiState> {
      await get(workspaceId)
      const now = new Date()
      const normalized = normalizeWorkspaceUiState(state)
      const existingViewState = await database
        .select()
        .from(workspaceViewStates)
        .where(eq(workspaceViewStates.workspaceId, workspaceId))
        .limit(1)
      const existingTabs = await database
        .select()
        .from(workspaceTabs)
        .where(eq(workspaceTabs.workspaceId, workspaceId))
        .orderBy(asc(workspaceTabs.position), asc(workspaceTabs.id))
      const nextTabRows = normalized.workspaceTabs.map((tab, idx) => tabToRow(workspaceId, tab, idx, now))
      if (
        existingViewState[0]
        && sameWorkspaceViewStateValues(existingViewState[0], normalized)
        && existingTabs.length === nextTabRows.length
        && existingTabs.every((tab, idx) => sameWorkspaceTabRow(tab, nextTabRows[idx]!))
      ) {
        return normalized
      }
      await database
        .insert(workspaceViewStates)
        .values({
          workspaceId,
          activeAgentSessionId: normalized.activeAgentSessionId,
          activeWorkspaceTabId: normalized.activeWorkspaceTabId,
          splitRatio: normalized.splitRatio,
          agentCollapsed: normalized.agentCollapsed,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: workspaceViewStates.workspaceId,
          set: {
            activeAgentSessionId: normalized.activeAgentSessionId,
            activeWorkspaceTabId: normalized.activeWorkspaceTabId,
            splitRatio: normalized.splitRatio,
            agentCollapsed: normalized.agentCollapsed,
            updatedAt: now,
          },
        })
      await database.delete(workspaceTabs).where(eq(workspaceTabs.workspaceId, workspaceId))
      if (nextTabRows.length > 0) {
        await database
          .insert(workspaceTabs)
          .values(nextTabRows)
          .onConflictDoUpdate({
            target: [workspaceTabs.workspaceId, workspaceTabs.id],
            set: {
              type: sql`excluded.type`,
              title: sql`excluded.title`,
              position: sql`excluded.position`,
              envId: sql`excluded.env_id`,
              shellId: sql`excluded.shell_id`,
              path: sql`excluded.path`,
              sessionId: sql`excluded.session_id`,
              port: sql`excluded.port`,
              url: sql`excluded.url`,
              browserTabId: sql`excluded.browser_tab_id`,
              updatedAt: sql`excluded.updated_at`,
            },
          })
      }
      return normalized
    },
  }
}

export const workspaceService = createWorkspaceService()
