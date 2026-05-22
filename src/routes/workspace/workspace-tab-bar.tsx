import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { trpc } from '../../trpc'
import { closeNativeBrowserTabsForWorkspace } from './browser-tab-cleanup'
import { archiveWorkspace, createWorkspace as createWorkspaceCommand, renameWorkspace, useVisibleWorkspaces } from '../../data/modules/workspaces'
import {
  idleRenameEditState,
  nextRenameValue,
  renameEditReducer,
} from './tab-bar-state'

type WorkspaceSummary = {
  id: string
  name: string
}

const PENDING_WORKSPACE_RENAME_KEY = 'cloud-code.pendingWorkspaceRenameId'
export function orderWorkspaceTabs(
  workspaces: WorkspaceSummary[],
  activeWorkspace?: WorkspaceSummary,
): WorkspaceSummary[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  if (activeWorkspace && !byId.has(activeWorkspace.id)) byId.set(activeWorkspace.id, activeWorkspace)
  const out: WorkspaceSummary[] = []
  for (const workspace of workspaces) {
    if (!byId.has(workspace.id)) continue
    out.push(workspace)
    byId.delete(workspace.id)
  }
  if (activeWorkspace && byId.has(activeWorkspace.id)) {
    out.push(activeWorkspace)
    byId.delete(activeWorkspace.id)
  }
  for (const workspace of byId.values()) out.push(workspace)
  return out
}

export function WorkspaceTabBar({
  activeWorkspaceId,
  activeWorkspaceName,
}: {
  activeWorkspaceId: string
  activeWorkspaceName: string
}) {
  const navigate = useNavigate()
  const trpcUtils = trpc.useUtils()
  const syncedWorkspaces = useVisibleWorkspaces()
  const [edit, dispatchEdit] = useReducer(renameEditReducer, idleRenameEditState)
  const [optimisticWorkspace, setOptimisticWorkspace] = useState<WorkspaceSummary | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (edit.editingId) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [edit.editingId])

  useEffect(() => {
    const pending = window.sessionStorage.getItem(PENDING_WORKSPACE_RENAME_KEY)
    if (pending !== activeWorkspaceId) return
    window.sessionStorage.removeItem(PENDING_WORKSPACE_RENAME_KEY)
    dispatchEdit({ type: 'begin', workspaceId: activeWorkspaceId, name: activeWorkspaceName })
  }, [activeWorkspaceId, activeWorkspaceName])

  async function createWorkspace() {
    const workspace = await createWorkspaceCommand({})
    setOptimisticWorkspace({ id: workspace.id, name: workspace.name })
    window.sessionStorage.setItem(PENDING_WORKSPACE_RENAME_KEY, workspace.id)
    dispatchEdit({ type: 'begin', workspaceId: workspace.id, name: workspace.name })
    await navigate({
      to: '/w/$workspaceId',
      params: { workspaceId: workspace.id },
      search: { chat: undefined, tab: undefined },
    })
  }

  async function saveRename() {
    if (!edit.editingId) return
    const nextName = nextRenameValue(edit)
    if (nextName) {
      await renameWorkspace({ id: edit.editingId, name: nextName })
      setOptimisticWorkspace((workspace) =>
        workspace?.id === edit.editingId ? { ...workspace, name: nextName } : workspace,
      )
    }
    dispatchEdit({ type: 'saved' })
  }

  async function closeWorkspace(workspaceId: string) {
    const tabs = await trpcUtils.workspace.listTabs.fetch({ workspaceId }).catch(() => [])
    await closeNativeBrowserTabsForWorkspace(tabs)
    await archiveWorkspace(workspaceId)
    const remaining = workspaces.filter((workspace) => workspace.id !== workspaceId)
    const next = remaining[0]
    if (workspaceId === activeWorkspaceId) {
      if (next) {
        await navigate({
          to: '/w/$workspaceId',
          params: { workspaceId: next.id },
          search: { chat: undefined, tab: undefined },
        })
      } else {
        await createWorkspace()
      }
    }
  }

  const workspaces = useMemo(() => {
    const rows: WorkspaceSummary[] = [...syncedWorkspaces]
    if (optimisticWorkspace && !rows.some((workspace) => workspace.id === optimisticWorkspace.id)) {
      rows.push(optimisticWorkspace)
    }
    const ordered = orderWorkspaceTabs(
      rows,
      { id: activeWorkspaceId, name: activeWorkspaceName },
    )
    return ordered
  }, [activeWorkspaceId, activeWorkspaceName, syncedWorkspaces, optimisticWorkspace])

  return (
    <div className="no-scrollbar flex items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap border-t border-neutral-800 bg-neutral-950 px-2 py-1 text-neutral-400">
      <button
        type="button"
        onClick={() => void createWorkspace()}
        className="rounded px-2 py-1 text-xs text-neutral-600 transition-colors hover:bg-highlight hover:text-neutral-100"
        aria-label="Create new workspace from tab bar"
        title="New workspace"
      >
        +
      </button>
      {workspaces.map((workspace) => {
        const active = workspace.id === activeWorkspaceId
        const editing = edit.editingId === workspace.id
        return editing ? (
          <input
            key={workspace.id}
            ref={inputRef}
            value={edit.draft}
            onChange={(e) => dispatchEdit({ type: 'change', draft: e.target.value })}
            onBlur={() => void saveRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveRename()
              if (e.key === 'Escape') dispatchEdit({ type: 'cancel' })
            }}
            className="min-w-32 rounded border border-neutral-600 bg-input px-2 py-1 text-xs text-neutral-100 outline-none"
            aria-label="Workspace name"
          />
        ) : (
          <Link
            key={workspace.id}
            to="/w/$workspaceId"
            params={{ workspaceId: workspace.id }}
            search={{ chat: undefined, tab: undefined }}
            onDoubleClick={(e) => {
              e.preventDefault()
              dispatchEdit({ type: 'begin', workspaceId: workspace.id, name: workspace.name })
            }}
            className={
              'group flex shrink-0 items-center gap-0.5 rounded transition-colors hover:bg-highlight hover:text-neutral-100 ' +
              (active ? 'bg-highlight text-neutral-100' : '')
            }
          >
            <span className="max-w-48 truncate whitespace-nowrap py-1 pl-2 pr-1 text-xs">{workspace.name}</span>
            <button
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void closeWorkspace(workspace.id)
              }}
              className="mr-1 rounded px-1 text-[11px] leading-none text-neutral-600 opacity-70 hover:bg-neutral-700 hover:text-neutral-100 group-hover:opacity-100"
              aria-label={`Close workspace ${workspace.name}`}
              title="Close workspace"
            >
              ×
            </button>
          </Link>
        )
      })}
    </div>
  )
}
