import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { workspaceTabFromPaneContent, workspaceTabKey, type PaneContent } from '../../shared/workspace-pane'
import { db, type Db } from '../db/client.js'
import {
  workspaceAgentTabs,
  workspaceTabs,
  workspaceUiStates,
  workspaceViewStates,
  workspaces,
  type WorkspaceTab,
  type WorkspaceTabRow,
  type WorkspaceAgentTabRow,
  type WorkspaceUiState,
  type WorkspaceViewState,
} from '../db/schema.js'

export type Workspace = typeof workspaces.$inferSelect

export class WorkspaceError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_name' | 'invalid_pane',
    message: string,
  ) {
    super(message)
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

function tabToRow(workspaceId: string, tab: WorkspaceTab, position: number, updatedAt: Date): WorkspaceTabRow {
  return {
    workspaceId,
    id: tab.id,
    type: tab.type,
    title: tab.title,
    position,
    envId: 'envId' in tab ? tab.envId : null,
    shellId: tab.type === 'shell' ? tab.shellId : null,
    path: tab.type === 'file' ? tab.path : null,
    sessionId: tab.type === 'file' ? (tab.sessionId ?? null) : null,
    port: tab.type === 'preview' ? tab.port : null,
    url: tab.type === 'browser' ? tab.url : null,
    browserTabId: tab.type === 'browser' ? (tab.browserTabId ?? null) : null,
    updatedAt,
  }
}

function rowToTab(row: WorkspaceTabRow): WorkspaceTab | null {
  if (row.type === 'shell' && row.envId && row.shellId) {
    return { id: row.id, type: 'shell', envId: row.envId, shellId: row.shellId, title: row.title }
  }
  if (row.type === 'file' && row.envId && row.path) {
    return { id: row.id, type: 'file', envId: row.envId, path: row.path, sessionId: row.sessionId ?? undefined, title: row.title }
  }
  if (row.type === 'preview' && row.envId && row.port !== null) {
    return { id: row.id, type: 'preview', envId: row.envId, port: row.port, title: row.title }
  }
  if (row.type === 'browser' && row.url) {
    return { id: row.id, type: 'browser', url: row.url, browserTabId: row.browserTabId ?? undefined, title: row.title }
  }
  return null
}

export function normalizeWorkspaceName(name: string | undefined): string {
  const trimmed = (name ?? '').trim()
  return trimmed || 'Untitled workspace'
}

function sortWorkspaces(rows: Workspace[]): Workspace[] {
  return [...rows].sort((a, b) => {
    const aOpened = a.lastOpenedAt?.getTime() ?? -1
    const bOpened = b.lastOpenedAt?.getTime() ?? -1
    if (aOpened !== bOpened) return bOpened - aOpened
    return b.createdAt.getTime() - a.createdAt.getTime()
  })
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
    await database
      .insert(workspaceTabs)
      .values(row)
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

  return {
    async list(): Promise<Workspace[]> {
      const rows = await database
        .select()
        .from(workspaces)
        .where(isNull(workspaces.archivedAt))
        .orderBy(desc(workspaces.lastOpenedAt), desc(workspaces.createdAt))
      return sortWorkspaces(rows)
    },

    get,

    async create(input?: { name?: string }): Promise<Workspace> {
      const id = ulid()
      const now = new Date()
      const row = {
        id,
        name: normalizeWorkspaceName(input?.name),
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
      await get(id)
      const now = new Date()
      const rows = await database
        .update(workspaces)
        .set({ name: nextName, updatedAt: now })
        .where(eq(workspaces.id, id))
        .returning()
      return rows[0] ?? (await get(id))
    },

    async archive(id: string): Promise<void> {
      await get(id)
      const now = new Date()
      await database
        .update(workspaces)
        .set({ archivedAt: now, updatedAt: now })
        .where(eq(workspaces.id, id))
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

    async saveUiState(workspaceId: string, state: WorkspaceUiState): Promise<WorkspaceUiState> {
      await get(workspaceId)
      const now = new Date()
      const normalized = normalizeWorkspaceUiState(state)
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
      const tabRows = normalized.workspaceTabs.map((tab, idx) => tabToRow(workspaceId, tab, idx, now))
      if (tabRows.length > 0) {
        await database
          .insert(workspaceTabs)
          .values(tabRows)
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
