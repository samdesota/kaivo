import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { trpc } from '../trpc'
import { openConfirmOverlay } from '../lib/overlay-layer-controller'
import { trpcQueryKey } from '../lib/trpc-plain'
import { extractTrpcMessage } from '../lib/utils'
import { RepoCombobox } from './repo-combobox'
import { Modal } from '../components/ui'

type Source = 'url' | 'github'

export interface NewConfigDraft {
  source: Source
  url: string
  repoFullName: string
  ref: string
  name: string
}

const emptyDraft = (): NewConfigDraft => ({
  source: 'url',
  url: '',
  repoFullName: '',
  ref: '',
  name: '',
})

/**
 * Inline form for creating a new global repo config. Calls onCreated with
 * the new config id so the parent can chain (e.g. select it for cloning).
 */
export function NewRepoConfigForm({
  onCreated,
  onCancel,
}: {
  onCreated: (configId: string) => void
  onCancel?: () => void
}) {
  const [draft, setDraft] = useState<NewConfigDraft>(emptyDraft)
  const [err, setErr] = useState<string | null>(null)
  const create = trpc.repoConfig.create.useMutation()
  const ghStatus = trpc.github.status.useQuery()
  const ghRepos = trpc.github.listOrgRepos.useQuery(undefined, {
    enabled: Boolean(ghStatus.data?.installed),
  })
  const queryClient = useQueryClient()

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      const cfg =
        draft.source === 'url'
          ? await create.mutateAsync({
              source: 'url',
              url: draft.url.trim(),
              name: draft.name.trim() || undefined,
              ref: draft.ref.trim() || undefined,
            })
          : await create.mutateAsync({
              source: 'github',
              repoFullName: draft.repoFullName,
              name: draft.name.trim() || undefined,
              ref: draft.ref.trim() || undefined,
            })
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('repoConfig.list') })
      onCreated(cfg.id)
    } catch (e2) {
      setErr(extractTrpcMessage(e2))
    }
  }

  const selectedGhRepo = ghRepos.data?.find((r) => r.fullName === draft.repoFullName)
  const defaultRefHint = selectedGhRepo?.defaultBranch ?? 'main'

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="flex gap-2 text-xs">
        <button
          type="button"
          onClick={() => setDraft({ ...draft, source: 'url' })}
          className={
            'rounded px-2 py-1 ' +
            (draft.source === 'url' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900')
          }
        >
          URL
        </button>
        <button
          type="button"
          onClick={() => setDraft({ ...draft, source: 'github' })}
          className={
            'rounded px-2 py-1 ' +
            (draft.source === 'github' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900')
          }
        >
          GitHub
        </button>
      </div>

      {draft.source === 'url' ? (
        <input
          value={draft.url}
          onChange={(e) => setDraft({ ...draft, url: e.target.value })}
          placeholder="https://github.com/user/repo.git"
          className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
        />
      ) : !ghStatus.data?.connected ? (
        <p className="text-xs text-neutral-500">
          GitHub App not connected.{' '}
          <Link to="/settings" className="text-neutral-300 hover:underline">
            Set up
          </Link>
        </p>
      ) : !ghStatus.data.installed ? (
        <p className="text-xs text-amber-300">GitHub App created but not installed.</p>
      ) : ghRepos.isLoading ? (
        <p className="text-xs text-neutral-500">Loading repos…</p>
      ) : ghRepos.error ? (
        <p className="text-xs text-red-400">{extractTrpcMessage(ghRepos.error)}</p>
      ) : ghRepos.data && ghRepos.data.length > 0 ? (
        <RepoCombobox
          repos={ghRepos.data}
          value={draft.repoFullName}
          onChange={(v) => setDraft({ ...draft, repoFullName: v })}
        />
      ) : (
        <p className="text-xs text-neutral-500">No repos accessible by this installation.</p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <input
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="config name (defaults to repo name)"
          className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
        />
        <input
          value={draft.ref}
          onChange={(e) => setDraft({ ...draft, ref: e.target.value })}
          placeholder={draft.source === 'github' ? `ref (default: ${defaultRefHint})` : 'branch / ref (optional)'}
          className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
        />
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={
            create.isPending ||
            (draft.source === 'url' ? !draft.url.trim() : !draft.repoFullName)
          }
          className="rounded bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {create.isPending ? 'Creating…' : 'Create config'}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
          >
            Cancel
          </button>
        )}
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
    </form>
  )
}

/**
 * Manage a single repo config: rename, set default ref, manage associated
 * files (path + encrypted contents). Used by Settings and the clone modal.
 */
export function RepoConfigEditor({ configId, onDeleted }: { configId: string; onDeleted?: () => void }) {
  const queryClient = useQueryClient()
  const cfg = trpc.repoConfig.get.useQuery({ id: configId })
  const files = trpc.repoConfig.listFiles.useQuery({ configId })
  const update = trpc.repoConfig.update.useMutation()
  const remove = trpc.repoConfig.remove.useMutation()
  const removeFile = trpc.repoConfig.removeFile.useMutation()
  const [name, setName] = useState('')
  const [ref, setRef] = useState('')
  const [editingFileId, setEditingFileId] = useState<string | 'new' | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (cfg.data) {
      setName(cfg.data.name)
      setRef(cfg.data.ref ?? '')
    }
  }, [cfg.data])

  async function onSave() {
    setErr(null)
    try {
      await update.mutateAsync({ id: configId, name, ref: ref || null })
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('repoConfig.get', { id: configId }) })
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('repoConfig.list') })
      setSavedAt(Date.now())
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  async function onDelete() {
    const confirmed = await openConfirmOverlay({
      title: 'Delete repo config?',
      message: `Delete config "${cfg.data?.name}"? Cloned repos using it remain but lose the link.`,
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!confirmed) return
    try {
      await remove.mutateAsync({ id: configId })
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('repoConfig.list') })
      onDeleted?.()
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  async function onRemoveFile(fileId: string, path: string) {
    const confirmed = await openConfirmOverlay({
      title: 'Remove config file?',
      message: `Remove file "${path}" from this config?`,
      confirmLabel: 'Remove',
      destructive: true,
    })
    if (!confirmed) return
    try {
      await removeFile.mutateAsync({ configId, fileId })
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('repoConfig.listFiles', { configId }) })
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  if (!cfg.data) return <p className="text-xs text-neutral-500">Loading…</p>

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-neutral-500">Source</div>
        <div className="rounded border border-neutral-800 bg-neutral-900/40 px-2 py-1.5 text-xs">
          <div className="font-mono text-neutral-300">
            {cfg.data.source === 'github' ? cfg.data.githubFullName : cfg.data.originUrl}
          </div>
          <div className="text-[10px] text-neutral-500">{cfg.data.source}</div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Name</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none"
            />
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Default ref</div>
            <input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="(repo default)"
              className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => void onSave()}
            disabled={update.isPending}
            className="rounded bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-700 disabled:opacity-60"
          >
            {update.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => void onDelete()}
            disabled={remove.isPending}
            className="rounded border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 disabled:opacity-60"
          >
            Delete config
          </button>
          {savedAt && Date.now() - savedAt < 2_000 && (
            <span className="text-[10px] text-emerald-400">saved</span>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">
            Files (placed into the workspace after clone)
          </div>
          {editingFileId === null && (
            <button
              onClick={() => setEditingFileId('new')}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-200 hover:bg-neutral-800"
            >
              + Add file
            </button>
          )}
        </div>

        {editingFileId === 'new' && (
          <FileEditor
            configId={configId}
            onClose={() => setEditingFileId(null)}
          />
        )}

        {files.data && files.data.length === 0 && editingFileId !== 'new' && (
          <p className="text-xs text-neutral-500">No files yet.</p>
        )}

        <ul className="space-y-1">
          {files.data?.map((f) =>
            editingFileId === f.id ? (
              <li key={f.id}>
                <FileEditor
                  configId={configId}
                  fileId={f.id}
                  initialPath={f.path}
                  onClose={() => setEditingFileId(null)}
                />
              </li>
            ) : (
              <li
                key={f.id}
                className="flex items-center justify-between gap-2 rounded border border-neutral-800 bg-neutral-900/40 px-2 py-1.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-neutral-200">{f.path}</div>
                  <div className="text-[10px] text-neutral-500">~{f.size}b · encrypted</div>
                </div>
                <button
                  onClick={() => setEditingFileId(f.id)}
                  className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-200 hover:bg-neutral-800"
                >
                  edit
                </button>
                <button
                  onClick={() => void onRemoveFile(f.id, f.path)}
                  className="rounded border border-neutral-800 bg-neutral-950 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                >
                  ×
                </button>
              </li>
            ),
          )}
        </ul>
      </div>

      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  )
}

function FileEditor({
  configId,
  fileId,
  initialPath,
  onClose,
}: {
  configId: string
  fileId?: string
  initialPath?: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const existing = trpc.repoConfig.readFile.useQuery(
    fileId ? { configId, fileId } : { configId, fileId: '' },
    { enabled: Boolean(fileId) },
  )
  const put = trpc.repoConfig.putFile.useMutation()
  const [path, setPath] = useState(initialPath ?? '')
  const [contents, setContents] = useState('')
  const [hydrated, setHydrated] = useState(!fileId)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (fileId && existing.data && !hydrated) {
      setPath(existing.data.path)
      setContents(existing.data.contents)
      setHydrated(true)
    }
  }, [fileId, existing.data, hydrated])

  async function onSave() {
    setErr(null)
    try {
      await put.mutateAsync({ configId, fileId, path: path.trim(), contents })
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('repoConfig.listFiles', { configId }) })
      onClose()
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  return (
    <div className="space-y-2 rounded border border-neutral-700 bg-neutral-900/60 p-2">
      <input
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder=".env"
        className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none"
      />
      <textarea
        value={contents}
        onChange={(e) => setContents(e.target.value)}
        placeholder={fileId && !hydrated ? 'loading…' : 'file contents (will be encrypted at rest)'}
        rows={8}
        spellCheck={false}
        disabled={Boolean(fileId) && !hydrated}
        className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-xs text-neutral-100 focus:border-neutral-600 focus:outline-none disabled:opacity-60"
      />
      <div className="flex gap-2">
        <button
          onClick={() => void onSave()}
          disabled={put.isPending || !path.trim()}
          className="rounded bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-700 disabled:opacity-60"
        >
          {put.isPending ? 'Saving…' : 'Save'}
        </button>
        <button
          onClick={onClose}
          className="rounded border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
        >
          Cancel
        </button>
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
    </div>
  )
}

/** Master/detail view of all global repo configs. */
export function RepoConfigsManager() {
  const list = trpc.repoConfig.list.useQuery()
  const [activeId, setActiveId] = useState<string | null>(null)

  return (
    <div>
      <div className="space-y-2">
        {list.isLoading && <p className="text-xs text-neutral-500">Loading…</p>}
        {list.data && list.data.length === 0 && (
          <p className="text-xs text-neutral-500">No repo configs yet.</p>
        )}
        <ul className="space-y-2">
          {list.data?.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => {
                  setActiveId(c.id)
                }}
                className={
                  'block w-full rounded border px-2 py-1.5 text-left text-xs ' +
                  (activeId === c.id
                    ? 'border-neutral-600 bg-neutral-900 text-neutral-100'
                    : 'border-neutral-800 bg-neutral-900/40 text-neutral-300 hover:bg-neutral-900')
                }
              >
                <div className="truncate font-medium">{c.name}</div>
                <div className="truncate text-[10px] text-neutral-500">
                  {c.source === 'github' ? c.githubFullName : c.originUrl} · {c.fileCount} file{c.fileCount === 1 ? '' : 's'}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <Modal
        open={Boolean(activeId)}
        onClose={() => setActiveId(null)}
        title="Repo config"
        widthClass="max-w-2xl"
      >
        {activeId ? <RepoConfigEditor configId={activeId} onDeleted={() => setActiveId(null)} /> : null}
      </Modal>
    </div>
  )
}

export function RepoConfigCreateButton() {
  const [creating, setCreating] = useState(false)
  return (
    <>
      <button
        onClick={() => setCreating(true)}
        className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-200 hover:bg-neutral-800"
      >
        + New
      </button>
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="New repo config"
        widthClass="max-w-lg"
      >
        <NewRepoConfigForm
          onCreated={() => setCreating(false)}
          onCancel={() => setCreating(false)}
        />
      </Modal>
    </>
  )
}
