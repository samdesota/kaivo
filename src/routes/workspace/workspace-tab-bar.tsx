import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { trpc } from '../../trpc'
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
const WORKSPACE_TAB_ORDER_KEY = 'cloud-code.workspaceTabOrder'

export function orderWorkspaceTabs(
  workspaces: WorkspaceSummary[],
  activeWorkspace?: WorkspaceSummary,
  persistedOrder: string[] = [],
): WorkspaceSummary[] {
  const byId = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
  if (activeWorkspace && !byId.has(activeWorkspace.id)) byId.set(activeWorkspace.id, activeWorkspace)
  const out: WorkspaceSummary[] = []
  for (const id of persistedOrder) {
    const workspace = byId.get(id)
    if (!workspace) continue
    out.push(workspace)
    byId.delete(id)
  }
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
  const utils = trpc.useUtils()
  const list = trpc.workspace.list.useQuery(undefined, { refetchInterval: 15_000 })
  const create = trpc.workspace.create.useMutation()
  const rename = trpc.workspace.rename.useMutation({
    onSuccess: () => utils.workspace.list.invalidate(),
  })
  const archive = trpc.workspace.archive.useMutation({
    onSuccess: () => utils.workspace.list.invalidate(),
  })
  const [edit, dispatchEdit] = useReducer(renameEditReducer, idleRenameEditState)
  const [optimisticWorkspace, setOptimisticWorkspace] = useState<WorkspaceSummary | null>(null)
  const [tabOrder, setTabOrder] = useState<string[]>(() => {
    try {
      const raw = window.localStorage.getItem(WORKSPACE_TAB_ORDER_KEY)
      return raw ? (JSON.parse(raw) as string[]) : []
    } catch {
      return []
    }
  })
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
    const workspace = await create.mutateAsync({})
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
      await rename.mutateAsync({ id: edit.editingId, name: nextName })
      setOptimisticWorkspace((workspace) =>
        workspace?.id === edit.editingId ? { ...workspace, name: nextName } : workspace,
      )
    }
    dispatchEdit({ type: 'saved' })
  }

  async function closeWorkspace(workspaceId: string) {
    await archive.mutateAsync({ id: workspaceId })
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
    const rows = [...((list.data ?? []) as WorkspaceSummary[])]
    if (optimisticWorkspace && !rows.some((workspace) => workspace.id === optimisticWorkspace.id)) {
      rows.push(optimisticWorkspace)
    }
    const ordered = orderWorkspaceTabs(
      rows,
      { id: activeWorkspaceId, name: activeWorkspaceName },
      tabOrder,
    )
    const nextOrder = ordered.map((workspace) => workspace.id)
    if (nextOrder.join('\0') !== tabOrder.join('\0')) {
      setTabOrder(nextOrder)
      try {
        window.localStorage.setItem(WORKSPACE_TAB_ORDER_KEY, JSON.stringify(nextOrder))
      } catch {
        // ignore disabled/quota storage
      }
    }
    return ordered
  }, [activeWorkspaceId, activeWorkspaceName, list.data, optimisticWorkspace, tabOrder])

  return (
    <div className="no-scrollbar flex items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap border-t border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-400">
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
            className="min-w-32 rounded border border-brand-500 bg-neutral-900 px-2 py-1 text-neutral-100 outline-none"
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
              'group flex shrink-0 items-center gap-1 rounded px-2 py-1 hover:bg-neutral-900 hover:text-neutral-100 ' +
              (active ? 'bg-neutral-800 text-neutral-100' : '')
            }
          >
            <span className="max-w-48 truncate whitespace-nowrap">{workspace.name}</span>
            <button
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                void closeWorkspace(workspace.id)
              }}
              className="rounded px-1 text-neutral-600 opacity-70 hover:bg-neutral-700 hover:text-neutral-100 group-hover:opacity-100"
              aria-label={`Close workspace ${workspace.name}`}
              title="Close workspace"
            >
              ×
            </button>
          </Link>
        )
      })}
      <button
        onClick={() => void createWorkspace()}
        disabled={create.isPending}
        className="shrink-0 rounded border border-neutral-800 px-2 py-1 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100 disabled:opacity-50"
        aria-label="Create new workspace"
      >
        +
      </button>
    </div>
  )
}
