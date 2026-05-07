import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { trpc } from '../../../trpc'
import { envTrpc } from '../../../env-trpc'
import { openConfirmOverlay, openNewAgentChatOverlayDetailed } from '../../../lib/overlay-layer-controller'
import { trpcQueryKey } from '../../../lib/trpc-plain'
import { extractTrpcMessage } from '../../../lib/utils'
import { useEnv } from '../env-context'
import { FolderPickerModal } from './folder-picker-modal'
import {
  defaultWorkspaceName,
  newAgentChatStartInput,
  resolveWorkspaceName,
  validateNewAgentChatSelection,
  type NewAgentChatWorkspaceMode,
  type NewAgentChatSelection,
} from './new-agent-chat-state'

type RecentFolder = { path: string; label: string | null; lastOpenedAt: Date | string }
type RepoConfig = { id: string; name: string; originUrl?: string | null; githubFullName?: string | null }
type RepoWorktree = {
  id: string
  name: string
  slug: string
  worktreeName: string
  worktreeSlug: string
  workingDir: string
  githubFullName?: string | null
}
type NewChatTab = 'folder' | 'worktree' | 'clone'

export function NewAgentChatModal({
  open,
  workspaceId,
  workspaceName = 'Current workspace',
  initialWorkspaceMode = 'existing',
  folderId,
  onClose,
  onCreated,
}: {
  open: boolean
  workspaceId?: string
  workspaceName?: string
  initialWorkspaceMode?: NewAgentChatWorkspaceMode
  folderId?: string | null
  onClose: () => void
  onCreated: (sessionId: string, workspaceId?: string) => void
}) {
  const envContext = useEnv()
  const launchedRef = useRef(false)

  useEffect(() => {
    if (!open) {
      launchedRef.current = false
      return
    }
    if (launchedRef.current) return
    launchedRef.current = true
    void openNewAgentChatOverlayDetailed({
      workspaceId,
      workspaceName,
      initialWorkspaceMode,
      folderId,
      env: envContext.env,
      envToken: envContext.envToken,
    }).then((result) => {
      if (result) onCreated(result.sessionId, result.workspaceId)
      onClose()
    }).catch((error) => {
      console.warn('new agent chat overlay failed', error)
      onClose()
    })
  }, [envContext.env, envContext.envToken, folderId, initialWorkspaceMode, onClose, onCreated, open, workspaceId, workspaceName])

  return null
}

export function NewAgentChatOverlay({
  workspaceId,
  workspaceName = 'Current workspace',
  initialWorkspaceMode = 'existing',
  folderId,
  onClose,
  onCreated,
}: {
  workspaceId?: string
  workspaceName?: string
  initialWorkspaceMode?: NewAgentChatWorkspaceMode
  folderId?: string | null
  onClose: () => void
  onCreated: (sessionId: string, workspaceId?: string) => void
}) {
  const recentFolders = envTrpc.repo.listRecentFolders.useQuery(undefined)
  const repoConfigs = envTrpc.repo.listConfigs.useQuery(undefined)
  const worktrees = envTrpc.repo.listWorktrees.useQuery(undefined)
  const cloneConfig = envTrpc.repo.cloneConfig.useMutation()
  const deleteWorktree = envTrpc.repo.deleteWorktree.useMutation()
  const start = envTrpc.agent.sessionStart.useMutation()
  const createWorkspace = trpc.workspace.create.useMutation()
  const queryClient = useQueryClient()
  const [selection, setSelection] = useState<NewAgentChatSelection | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<NewChatTab>('folder')
  const [folderFilter, setFolderFilter] = useState('')
  const [workspaceMode, setWorkspaceMode] = useState<NewAgentChatWorkspaceMode>(initialWorkspaceMode)
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState({ value: '', edited: false })
  const folderSearchRef = useRef<HTMLInputElement | null>(null)

  const busy = start.isPending || cloneConfig.isPending || deleteWorktree.isPending || createWorkspace.isPending
  const validation = validateNewAgentChatSelection(selection)

  async function createChat() {
    const invalid = validateNewAgentChatSelection(selection)
    if (invalid || !selection) {
      setError(invalid)
      return
    }
    setError(null)
    try {
      let workingDir: string
      if (selection.type === 'folder') {
        workingDir = selection.path
      } else if (selection.type === 'worktree') {
        workingDir = selection.path
      } else {
        const cloned = await cloneConfig.mutateAsync({
          configId: selection.configId,
          worktreeName: selection.worktreeName,
        })
        workingDir = cloned.workingDir
      }
      let targetWorkspaceId = workspaceId
      if (workspaceMode === 'new' || !targetWorkspaceId) {
        const resolved = resolveWorkspaceName(selection, workspaceNameDraft)
        const workspace = await createWorkspace.mutateAsync({
          name: resolved.name,
          folderId: folderId ?? null,
          nameSource: resolved.source,
          sourceKind: selection.type === 'folder' ? 'folder' : selection.type === 'worktree' ? 'worktree' : 'repo_config',
          sourcePath: workingDir,
        })
        targetWorkspaceId = workspace.id
      }
      const session = (await start.mutateAsync(newAgentChatStartInput(targetWorkspaceId, workingDir))) as { id: string }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList', { workspaceId: targetWorkspaceId }) }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.list') }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.listTree') }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('repo.listRecentFolders') }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('repo.listWorktrees') }),
      ])
      onCreated(session.id, targetWorkspaceId)
      onClose()
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  const folders = (recentFolders.data ?? []) as RecentFolder[]
  const configs = (repoConfigs.data ?? []) as RepoConfig[]
  const existingWorktrees = (worktrees.data ?? []) as RepoWorktree[]
  const filteredFolders = useMemo(() => {
    const q = folderFilter.trim().toLowerCase()
    if (!q) return folders
    return folders.filter((folder) => `${folder.label ?? ''} ${folder.path}`.toLowerCase().includes(q))
  }, [folderFilter, folders])
  const selectedConfig = selection?.type === 'repoConfig' ? configs.find((config) => config.id === selection.configId) : null
  const clonePreview = selectedConfig && selection?.type === 'repoConfig'
    ? `repos/${slugify(selectedConfig.name)}/${slugify(selection.worktreeName || 'work-tree')}`
    : null
  const generatedWorkspaceName = defaultWorkspaceName(selection).name
  const workspaceNameValue = resolveWorkspaceName(selection, workspaceNameDraft).name

  async function removeWorktree(worktree: RepoWorktree) {
    const confirmed = await openConfirmOverlay({
      title: `Delete ${worktree.name}/${worktree.worktreeName}?`,
      message: worktree.workingDir,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!confirmed) return
    setError(null)
    try {
      await deleteWorktree.mutateAsync({ repoId: worktree.id })
      if (selection?.type === 'worktree' && selection.repoId === worktree.id) setSelection(null)
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('repo.listWorktrees') })
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  useEffect(() => {
    if (activeTab !== 'folder') return
    const id = requestAnimationFrame(() => folderSearchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [activeTab])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[84vh] min-h-0 w-full max-w-2xl flex-col rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-neutral-800 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-100">New agent chat</h2>
            <p className="mt-1 text-xs text-neutral-500">Choose where the agent should work.</p>
          </div>
          <WorkspaceModeControl
            mode={workspaceMode}
            onModeChange={setWorkspaceMode}
            existingWorkspaceName={workspaceName}
            workspaceNameValue={workspaceNameDraft.edited ? workspaceNameDraft.value : generatedWorkspaceName}
            resolvedWorkspaceName={workspaceNameValue}
            onWorkspaceNameChange={(value) => setWorkspaceNameDraft({ value, edited: true })}
          />
        </div>
        <div className="flex shrink-0 border-b border-neutral-800 px-3 pt-3">
          <TabButton active={activeTab === 'folder'} onClick={() => setActiveTab('folder')}>Folders</TabButton>
          <TabButton active={activeTab === 'worktree'} onClick={() => setActiveTab('worktree')}>Work trees</TabButton>
          <TabButton active={activeTab === 'clone'} onClick={() => setActiveTab('clone')}>Clone config</TabButton>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden p-4">
          {activeTab === 'folder' && (
            <section className="flex h-full min-h-0 flex-col gap-3">
              <div className="flex gap-2">
                <input
                  ref={folderSearchRef}
                  value={folderFilter}
                  onChange={(event) => setFolderFilter(event.target.value)}
                  placeholder="Search recent folders…"
                  className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-brand-500"
                />
                <button
                  onClick={() => setPickerOpen(true)}
                  className="shrink-0 rounded border border-neutral-700 px-3 py-2 text-xs text-neutral-300 hover:border-brand-500/60 hover:bg-neutral-900"
                >
                  Browse…
                </button>
              </div>
              {recentFolders.isLoading && <div className="text-xs text-neutral-500">Loading recent folders…</div>}
              <div className="min-h-0 flex-1 overflow-y-auto rounded border border-neutral-900 bg-neutral-950/40 p-1">
                {filteredFolders.map((folder) => (
                  <button
                    key={folder.path}
                    onClick={() => setSelection({ type: 'folder', path: folder.path })}
                    className={compactChoiceClass(selection?.type === 'folder' && selection.path === folder.path)}
                  >
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="shrink-0 truncate text-neutral-100">{folder.label ?? folderName(folder.path)}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-neutral-500" title={folder.path}>{folder.path}</span>
                    </span>
                  </button>
                ))}
                {folders.length === 0 && !recentFolders.isLoading && <EmptyList>No recent folders yet.</EmptyList>}
                {folders.length > 0 && filteredFolders.length === 0 && <EmptyList>No folders match “{folderFilter}”.</EmptyList>}
              </div>
            </section>
          )}
          {activeTab === 'worktree' && (
            <section className="flex h-full min-h-0 flex-col gap-2">
              {worktrees.isLoading && <div className="text-xs text-neutral-500">Loading work trees…</div>}
              <div className="min-h-0 flex-1 overflow-y-auto rounded border border-neutral-900 bg-neutral-950/40 p-1">
                {existingWorktrees.map((worktree) => (
                  <div
                    key={worktree.id}
                    className={compactChoiceClass(selection?.type === 'worktree' && selection.repoId === worktree.id, 'row')}
                  >
                    <button
                      onClick={() => setSelection({ type: 'worktree', repoId: worktree.id, path: worktree.workingDir, name: worktree.worktreeName })}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate text-neutral-100">{worktree.name} / {worktree.worktreeName}</span>
                      <span className="block truncate font-mono text-[10px] text-neutral-500" title={worktree.workingDir}>{worktree.workingDir}</span>
                    </button>
                    <button
                      onClick={(event) => {
                        event.stopPropagation()
                        void removeWorktree(worktree)
                      }}
                      disabled={busy}
                      className="ml-2 shrink-0 rounded border border-neutral-700 px-2 py-1 text-[10px] text-neutral-400 hover:border-red-700 hover:text-red-300 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                ))}
                {existingWorktrees.length === 0 && !worktrees.isLoading && <EmptyList>No cloned work trees yet.</EmptyList>}
              </div>
            </section>
          )}
          {activeTab === 'clone' && (
            <section className="flex h-full min-h-0 flex-col gap-3">
              {repoConfigs.isLoading && <div className="text-xs text-neutral-500">Loading repo configs…</div>}
              <div className="min-h-0 flex-1 overflow-y-auto rounded border border-neutral-900 bg-neutral-950/40 p-1">
                {configs.map((config) => (
                  <button
                    key={config.id}
                    onClick={() => setSelection({
                      type: 'repoConfig',
                      configId: config.id,
                      worktreeName: selection?.type === 'repoConfig' ? selection.worktreeName : '',
                    })}
                    className={compactChoiceClass(selection?.type === 'repoConfig' && selection.configId === config.id)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-neutral-100">{config.name}</span>
                      <span className="block truncate text-[10px] text-neutral-500" title={config.githubFullName ?? config.originUrl ?? config.id}>{config.githubFullName ?? config.originUrl ?? config.id}</span>
                    </span>
                  </button>
                ))}
                {configs.length === 0 && !repoConfigs.isLoading && <EmptyList>No repo configs yet.</EmptyList>}
              </div>
              <label className="block space-y-1 text-xs text-neutral-400">
                <span>Work tree name</span>
                <input
                  value={selection?.type === 'repoConfig' ? selection.worktreeName : ''}
                  onChange={(event) => {
                    const fallbackConfigId = configs[0]?.id ?? ''
                    setSelection({
                      type: 'repoConfig',
                      configId: selection?.type === 'repoConfig' ? selection.configId : fallbackConfigId,
                      worktreeName: event.target.value,
                    })
                  }}
                  placeholder="bug-shell-resize"
                  className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-100 outline-none focus:border-brand-500"
                />
              </label>
              {clonePreview && (
                <div className="truncate rounded border border-neutral-800 bg-neutral-900/40 p-2 text-[10px] text-neutral-500" title={clonePreview}>
                  Will clone to <span className="font-mono text-neutral-300">{clonePreview}</span>
                </div>
              )}
            </section>
          )}
        </div>
        {error && <div className="mx-4 shrink-0 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</div>}
        <div className="flex shrink-0 justify-end gap-2 border-t border-neutral-800 px-4 py-3">
          <button onClick={onClose} className="rounded px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-900">Cancel</button>
          <button
            onClick={() => void createChat()}
            disabled={busy || !!validation}
            className="rounded bg-brand-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create chat'}
          </button>
        </div>
      </div>
      <FolderPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        busy={busy}
        onSelect={(path) => {
          setSelection({ type: 'folder', path })
          setPickerOpen(false)
        }}
      />
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'border-b px-3 py-2 text-xs font-medium ' +
        (active
          ? 'border-brand-500 text-neutral-100'
          : 'border-transparent text-neutral-500 hover:text-neutral-300')
      }
    >
      {children}
    </button>
  )
}

export function WorkspaceModeControl({
  mode,
  onModeChange,
  existingWorkspaceName,
  workspaceNameValue,
  resolvedWorkspaceName,
  onWorkspaceNameChange,
}: {
  mode: NewAgentChatWorkspaceMode
  onModeChange: (mode: NewAgentChatWorkspaceMode) => void
  existingWorkspaceName: string
  workspaceNameValue: string
  resolvedWorkspaceName?: string
  onWorkspaceNameChange: (value: string) => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 text-xs text-neutral-500">
      <span>Workspace</span>
      <select
        aria-label="Workspace mode"
        value={mode}
        onChange={(event) => onModeChange(event.target.value as NewAgentChatWorkspaceMode)}
        className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-brand-500"
      >
        <option value="new">New</option>
        <option value="existing">Existing</option>
      </select>
      {mode === 'new' ? (
        <input
          aria-label="Workspace name"
          value={workspaceNameValue}
          onChange={(event) => onWorkspaceNameChange(event.target.value)}
          title={resolvedWorkspaceName ?? workspaceNameValue}
          className="w-36 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-brand-500"
        />
      ) : (
        <span className="max-w-44 truncate rounded border border-neutral-900 bg-neutral-900/40 px-2 py-1 text-neutral-300" title={existingWorkspaceName}>
          {existingWorkspaceName}
        </span>
      )}
    </div>
  )
}

function EmptyList({ children }: { children: ReactNode }) {
  return <div className="p-4 text-center text-xs text-neutral-500">{children}</div>
}

function compactChoiceClass(selected: boolean, layout: 'col' | 'row' = 'col'): string {
  return (
    `flex w-full min-w-0 ${layout === 'col' ? 'items-center' : 'items-start'} rounded border px-2.5 py-2 text-left text-xs hover:border-brand-500/60 hover:bg-neutral-900 ` +
    (selected ? 'border-brand-500 bg-brand-500/10' : 'border-neutral-800 bg-neutral-900/40')
  )
}

function folderName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'work-tree'
}
