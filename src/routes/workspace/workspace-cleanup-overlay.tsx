import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { envTrpc } from '../../env-trpc'
import { Modal } from '../../components/ui'
import { extractTrpcMessage } from '../../lib/utils'
import { createWorkspaceResourceCleanupRegistry, type CleanupResourceRow } from './resource-cleanup'
import type { WorkspaceResourceRecord } from './resources-store'

type WorkspaceSummary = {
  id: string
  name: string
}

export function WorkspaceCleanupOverlay({
  workspace,
  allWorkspaces,
  resources,
  onCancel,
  onCleaned,
}: {
  workspace: WorkspaceSummary
  allWorkspaces: WorkspaceSummary[]
  resources: WorkspaceResourceRecord[]
  onCancel: () => void
  onCleaned: () => void
}) {
  const envUtils = envTrpc.useUtils()
  const { mutateAsync: disposeShellAsync } = envTrpc.shell.dispose.useMutation()
  const { mutateAsync: deleteWorktreeAsync } = envTrpc.repo.deleteWorktree.useMutation()
  const [cleanupRows, setCleanupRows] = useState<CleanupResourceRow[]>([])
  const [loadingResources, setLoadingResources] = useState(true)
  const [selectedCleanupIds, setSelectedCleanupIds] = useState<Set<string>>(() => new Set())
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const resourcesRef = useRef(resources)
  const envUtilsRef = useRef(envUtils)
  const disposeShellAsyncRef = useRef(disposeShellAsync)
  const deleteWorktreeAsyncRef = useRef(deleteWorktreeAsync)
  resourcesRef.current = resources
  envUtilsRef.current = envUtils
  disposeShellAsyncRef.current = disposeShellAsync
  deleteWorktreeAsyncRef.current = deleteWorktreeAsync
  const workspaceResources = useMemo(() => resources.filter((resource) => resource.workspaceId === workspace.id), [resources, workspace.id])
  const workspaceResourceSignature = workspaceResources.map((resource) => `${resource.id}:${resource.type}:${resource.resourceKey}:${resource.shared}:${JSON.stringify(resource.data)}`).join('\0')
  const listShells = useCallback(() => envUtilsRef.current.shell.list.fetch({ workspaceId: workspace.id }) as Promise<Array<{ id: string }>>, [workspace.id])
  const cleanupShell = useCallback((id: string) => disposeShellAsyncRef.current({ id }), [])
  const listWorktrees = useCallback(() => envUtilsRef.current.repo.listWorktrees.fetch() as Promise<Array<{ id: string; workingDir: string }>>, [])
  const cleanupWorktree = useCallback((repoId: string) => deleteWorktreeAsyncRef.current({ repoId }), [])
  const makeCleanupRegistry = useCallback(() => createWorkspaceResourceCleanupRegistry({
    workspaceId: workspace.id,
    resources: resourcesRef.current,
    listShells,
    disposeShell: cleanupShell,
    listWorktrees,
    deleteWorktree: cleanupWorktree,
  }), [cleanupShell, cleanupWorktree, listShells, listWorktrees, workspace.id])

  useEffect(() => {
    let cancelled = false
    async function loadRows() {
      setLoadingResources(true)
      try {
        const next: CleanupResourceRow[] = []
        const seen = new Set<string>()
        const registry = makeCleanupRegistry()
        const currentWorkspaceResources = resourcesRef.current.filter((resource) => resource.workspaceId === workspace.id)
        for (const resource of currentWorkspaceResources) {
          const handler = registry.handlerFor(resource.type)
          if (!await handler.exists(resource)) continue
          const row = handler.row(resource)
          if (seen.has(row.id)) continue
          seen.add(row.id)
          next.push(row)
        }
        if (!cancelled) setCleanupRows(next)
      } finally {
        if (!cancelled) setLoadingResources(false)
      }
    }
    void loadRows()
    return () => {
      cancelled = true
    }
  }, [makeCleanupRegistry, workspace.id, workspaceResourceSignature])

  const cleanupableIds = cleanupRows.filter((row) => row.canCleanup).map((row) => row.id)

  useEffect(() => {
    setSelectedCleanupIds((current) => current.size === 0 ? new Set(cleanupableIds) : current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanupableIds.join('\0')])

  function toggleCleanup(resourceId: string) {
    setSelectedCleanupIds((current) => {
      const next = new Set(current)
      if (next.has(resourceId)) next.delete(resourceId)
      else next.add(resourceId)
      return next
    })
  }

  async function cleanResources(resourceIds: Set<string>) {
    const registry = makeCleanupRegistry()
    const currentWorkspaceResources = resourcesRef.current.filter((resource) => resource.workspaceId === workspace.id)
    await Promise.all(currentWorkspaceResources.map(async (resource) => {
      if (!resourceIds.has(resource.id)) return
      const handler = registry.handlerFor(resource.type)
      if (!await handler.exists(resource)) return
      const row = handler.row(resource)
      if (!row.canCleanup) return
      await handler.cleanup(resource)
    }))
  }

  async function archiveWithCleanup() {
    setErr(null)
    setBusy(true)
    try {
      await cleanResources(selectedCleanupIds)
      onCleaned()
    } catch (error) {
      setErr(extractTrpcMessage(error))
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onCancel} title="Archive workspace?" widthClass="max-w-lg">
      <div className="space-y-3 text-xs text-neutral-300">
        <div className="text-neutral-500">{workspace.name}</div>
        <p>Select resources to clean up before archiving.</p>
        <div>
          <div className="flex items-center justify-between border-b border-neutral-850 px-2 py-1.5 text-[11px] text-neutral-500">
            <span>{cleanupRows.length} resource{cleanupRows.length === 1 ? '' : 's'}</span>
            <span>{selectedCleanupIds.size} selected</span>
          </div>
          <div className="max-h-64 divide-y divide-neutral-900 overflow-y-auto">
            {cleanupRows.length === 0 ? (
              <div className="px-3 py-6 text-center text-neutral-600">No tracked resources.</div>
            ) : cleanupRows.map((row) => (
              <label key={row.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-neutral-900/60">
                <input
                  type="checkbox"
                  checked={selectedCleanupIds.has(row.id)}
                  disabled={!row.canCleanup || busy}
                  onChange={() => toggleCleanup(row.id)}
                  className="h-3 w-3 shrink-0 accent-neutral-500 disabled:opacity-40"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-neutral-500">{row.type}</span>
                    <span className="truncate font-mono text-[11px] text-neutral-200">{row.label}</span>
                  </div>
                  {row.detail && <div className="truncate text-[10px] text-neutral-600">{row.detail}</div>}
                </div>
                {row.shared && <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-200">shared</span>}
                {row.shared && (
                  <span className={(row.orphan ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-neutral-700 bg-neutral-900 text-neutral-500') + ' shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wide'}>
                    {row.orphan ? 'orphan' : 'in use'}
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>
        {allWorkspaces.length <= 1 && <div className="text-neutral-500">This is the last active workspace.</div>}
        {err && <div className="rounded border border-red-900 bg-red-950/50 px-2 py-1 text-red-300">{err}</div>}
        <div className="flex justify-end gap-2 border-t border-neutral-800 pt-3">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-60">Cancel</button>
          <button type="button" onClick={() => void archiveWithCleanup()} disabled={busy || loadingResources} className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-60">
            {busy ? 'Archiving...' : 'Archive and cleanup'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
