import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { envTrpc } from '../../../env-trpc'
import { trpcQueryKey } from '../../../lib/trpc-plain'
import { extractTrpcMessage } from '../../../lib/utils'
import { FolderPickerModal } from './folder-picker-modal'
import {
  newAgentChatStartInput,
  validateNewAgentChatSelection,
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

export function NewAgentChatModal({
  open,
  workspaceId,
  onClose,
  onCreated,
}: {
  open: boolean
  workspaceId: string
  onClose: () => void
  onCreated: (sessionId: string) => void
}) {
  if (!open) return null

  return <NewAgentChatOverlay workspaceId={workspaceId} onClose={onClose} onCreated={onCreated} />
}

export function NewAgentChatOverlay({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string
  onClose: () => void
  onCreated: (sessionId: string) => void
}) {
  const recentFolders = envTrpc.repo.listRecentFolders.useQuery(undefined)
  const repoConfigs = envTrpc.repo.listConfigs.useQuery(undefined)
  const worktrees = envTrpc.repo.listWorktrees.useQuery(undefined)
  const cloneConfig = envTrpc.repo.cloneConfig.useMutation()
  const deleteWorktree = envTrpc.repo.deleteWorktree.useMutation()
  const start = envTrpc.agent.sessionStart.useMutation()
  const queryClient = useQueryClient()
  const [selection, setSelection] = useState<NewAgentChatSelection | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const busy = start.isPending || cloneConfig.isPending || deleteWorktree.isPending
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
      const session = (await start.mutateAsync(newAgentChatStartInput(workspaceId, workingDir))) as { id: string }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList', { workspaceId }) }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('repo.listRecentFolders') }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('repo.listWorktrees') }),
      ])
      onCreated(session.id)
      onClose()
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  const folders = (recentFolders.data ?? []) as RecentFolder[]
  const configs = (repoConfigs.data ?? []) as RepoConfig[]
  const existingWorktrees = (worktrees.data ?? []) as RepoWorktree[]
  const selectedConfig = selection?.type === 'repoConfig' ? configs.find((config) => config.id === selection.configId) : null
  const clonePreview = selectedConfig && selection?.type === 'repoConfig'
    ? `repos/${slugify(selectedConfig.name)}/${slugify(selection.worktreeName || 'work-tree')}`
    : null

  async function removeWorktree(worktree: RepoWorktree) {
    if (!window.confirm(`Delete ${worktree.name}/${worktree.worktreeName}?\n\n${worktree.workingDir}`)) return
    setError(null)
    try {
      await deleteWorktree.mutateAsync({ repoId: worktree.id })
      if (selection?.type === 'worktree' && selection.repoId === worktree.id) setSelection(null)
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('repo.listWorktrees') })
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-3xl rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl">
        <div className="border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-100">New agent chat</h2>
          <p className="mt-1 text-xs text-neutral-500">Start from a folder, an existing work tree, or a new repo config clone.</p>
        </div>
        <div className="grid gap-4 p-4 lg:grid-cols-3">
          <section className="space-y-2">
            <div className="text-[10px] uppercase tracking-wide text-neutral-500">Open folder</div>
            {recentFolders.isLoading && <div className="text-xs text-neutral-500">Loading recent folders…</div>}
            {folders.map((folder) => (
              <button
                key={folder.path}
                onClick={() => setSelection({ type: 'folder', path: folder.path })}
                className={choiceClass(selection?.type === 'folder' && selection.path === folder.path)}
              >
                <span className="truncate text-neutral-100">{folder.label ?? folder.path}</span>
                <span className="truncate font-mono text-[10px] text-neutral-500">{folder.path}</span>
              </button>
            ))}
            {folders.length === 0 && !recentFolders.isLoading && (
              <div className="rounded border border-neutral-800 p-3 text-xs text-neutral-500">No recent folders yet.</div>
            )}
            <button
              onClick={() => setPickerOpen(true)}
              className="w-full rounded border border-dashed border-neutral-700 px-3 py-2 text-left text-xs text-neutral-300 hover:border-brand-500/60"
            >
              Choose any folder…
            </button>
          </section>
          <section className="space-y-2">
            <div className="text-[10px] uppercase tracking-wide text-neutral-500">Existing work tree</div>
            {worktrees.isLoading && <div className="text-xs text-neutral-500">Loading work trees…</div>}
            {existingWorktrees.map((worktree) => (
              <div
                key={worktree.id}
                className={choiceClass(selection?.type === 'worktree' && selection.repoId === worktree.id, 'row')}
              >
                <button
                  onClick={() => setSelection({ type: 'worktree', repoId: worktree.id, path: worktree.workingDir })}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-neutral-100">{worktree.name} / {worktree.worktreeName}</span>
                  <span className="block truncate font-mono text-[10px] text-neutral-500">{worktree.workingDir}</span>
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
            {existingWorktrees.length === 0 && !worktrees.isLoading && (
              <div className="rounded border border-neutral-800 p-3 text-xs text-neutral-500">No cloned work trees yet.</div>
            )}
          </section>
          <section className="space-y-2">
            <div className="text-[10px] uppercase tracking-wide text-neutral-500">Clone repo config</div>
            {repoConfigs.isLoading && <div className="text-xs text-neutral-500">Loading repo configs…</div>}
            {configs.map((config) => (
              <button
                key={config.id}
                onClick={() => setSelection({
                  type: 'repoConfig',
                  configId: config.id,
                  worktreeName: selection?.type === 'repoConfig' ? selection.worktreeName : '',
                })}
                className={choiceClass(selection?.type === 'repoConfig' && selection.configId === config.id)}
              >
                <span className="truncate text-neutral-100">{config.name}</span>
                <span className="truncate text-[10px] text-neutral-500">{config.githubFullName ?? config.originUrl ?? config.id}</span>
              </button>
            ))}
            {configs.length === 0 && !repoConfigs.isLoading && (
              <div className="rounded border border-neutral-800 p-3 text-xs text-neutral-500">No repo configs yet.</div>
            )}
            <label className="block space-y-1 pt-2 text-xs text-neutral-400">
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
              <div className="rounded border border-neutral-800 bg-neutral-900/40 p-2 text-[10px] text-neutral-500">
                Will clone to <span className="font-mono text-neutral-300">{clonePreview}</span>
              </div>
            )}
          </section>
        </div>
        {error && <div className="mx-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</div>}
        <div className="flex justify-end gap-2 border-t border-neutral-800 px-4 py-3">
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

function choiceClass(selected: boolean, layout: 'col' | 'row' = 'col'): string {
  return (
    `flex w-full ${layout === 'col' ? 'flex-col' : 'items-start'} rounded border px-3 py-2 text-left text-xs hover:border-brand-500/60 hover:bg-neutral-900 ` +
    (selected ? 'border-brand-500 bg-brand-500/10' : 'border-neutral-800 bg-neutral-900/40')
  )
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'work-tree'
}
