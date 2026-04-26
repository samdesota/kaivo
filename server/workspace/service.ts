import { desc, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db, type Db } from '../db/client.js'
import { workspaceUiStates, workspaces, type WorkspaceUiState } from '../db/schema.js'

export type Workspace = typeof workspaces.$inferSelect

export class WorkspaceError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_name',
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
  tabOrder: [],
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
    const rows = await database
      .select()
      .from(workspaceUiStates)
      .where(eq(workspaceUiStates.workspaceId, workspaceId))
      .limit(1)
    return rows[0]?.state ?? EMPTY_WORKSPACE_UI_STATE
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
      await database.insert(workspaceUiStates).values({
        workspaceId: id,
        state: EMPTY_WORKSPACE_UI_STATE,
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

    async saveUiState(workspaceId: string, state: WorkspaceUiState): Promise<WorkspaceUiState> {
      await get(workspaceId)
      const now = new Date()
      await database
        .insert(workspaceUiStates)
        .values({ workspaceId, state, updatedAt: now })
        .onConflictDoUpdate({
          target: workspaceUiStates.workspaceId,
          set: { state, updatedAt: now },
        })
      return state
    },
  }
}

export const workspaceService = createWorkspaceService()
