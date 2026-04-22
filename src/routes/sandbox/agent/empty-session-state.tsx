import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { trpc } from '../../../trpc'
import { extractTrpcMessage } from '../../../lib/utils'
import { RepoCombobox } from '../repos'

/**
 * Shown in the Agents pane when a sandbox has no active sessions. Lists
 * any repos in the sandbox as clickable cards ("Start session in …") and
 * exposes an Add-repo form for when the sandbox is fresh. Clicking a repo
 * creates the session in one shot — no modal, no prompt up front.
 */
export function EmptySessionState({
  sandboxId,
  onCreated,
}: {
  sandboxId: string
  onCreated: (sessionId: string) => void
}) {
  const repos = trpc.repo.list.useQuery({ sandboxId }, { refetchInterval: 5_000 })
  const start = trpc.agent.sessionStart.useMutation()
  const [err, setErr] = useState<string | null>(null)

  async function createIn(directory?: string) {
    setErr(null)
    try {
      const res = await start.mutateAsync({ sandboxId, directory })
      onCreated(res.id)
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
      <div className="mx-auto w-full max-w-md space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-neutral-100">No sessions yet</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Pick a repo to start a new agent session in, or add one below.
          </p>
        </div>

        <section className="space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Repos</div>
          {repos.isLoading && (
            <div className="text-xs text-neutral-500">Loading repos…</div>
          )}
          {repos.data && repos.data.length === 0 && (
            <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-500">
              This sandbox has no repos yet. Add one below.
            </div>
          )}
          {repos.data?.map((r) => (
            <button
              key={r.id}
              onClick={() => void createIn(r.workspacePath)}
              disabled={start.isPending}
              className="flex w-full items-center justify-between gap-2 rounded border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-left hover:border-brand-500/60 hover:bg-neutral-900 disabled:opacity-60"
            >
              <div className="min-w-0">
                <div className="truncate text-sm text-neutral-100">{r.slug}</div>
                <div className="truncate font-mono text-[11px] text-neutral-500">
                  {r.workspacePath}
                </div>
              </div>
              <span className="shrink-0 rounded bg-brand-500/10 px-2 py-0.5 text-[11px] text-brand-400">
                Start →
              </span>
            </button>
          ))}
          <button
            onClick={() => void createIn(undefined)}
            disabled={start.isPending}
            className="mt-1 w-full rounded border border-dashed border-neutral-800 px-3 py-2 text-left text-xs text-neutral-500 hover:border-neutral-700 hover:text-neutral-300 disabled:opacity-60"
          >
            Start without a repo — work in <span className="font-mono">/workspace</span>
          </button>
        </section>

        <section className="space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Add a repo</div>
          <AddRepoForm sandboxId={sandboxId} />
        </section>

        {err && (
          <div className="rounded border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">
            {err}
          </div>
        )}
      </div>
    </div>
  )
}

type AddMode = 'url' | 'github'

function AddRepoForm({ sandboxId }: { sandboxId: string }) {
  const utils = trpc.useUtils()
  const add = trpc.repo.add.useMutation()
  const ghStatus = trpc.github.status.useQuery()
  const ghRepos = trpc.github.listOrgRepos.useQuery(undefined, {
    enabled: Boolean(ghStatus.data?.installed),
  })

  const [mode, setMode] = useState<AddMode>('url')
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [selectedGh, setSelectedGh] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    try {
      if (mode === 'url') {
        const u = url.trim()
        if (!u) return
        await add.mutateAsync({
          source: 'url',
          sandboxId,
          url: u,
          ref: ref.trim() || undefined,
        })
        setUrl('')
      } else {
        if (!selectedGh) return
        await add.mutateAsync({
          source: 'github',
          sandboxId,
          repoFullName: selectedGh,
          ref: ref.trim() || undefined,
        })
        setSelectedGh('')
      }
      setRef('')
      await utils.repo.list.invalidate({ sandboxId })
    } catch (e2) {
      setErr(extractTrpcMessage(e2))
    }
  }

  const selectedGhRepo = ghRepos.data?.find((r) => r.fullName === selectedGh)
  const defaultRefHint = selectedGhRepo?.defaultBranch ?? 'main'

  return (
    <form onSubmit={onSubmit} className="space-y-2 rounded border border-neutral-800 bg-neutral-900/40 p-3">
      <div className="flex gap-2 text-xs">
        <button
          type="button"
          onClick={() => setMode('url')}
          className={
            'rounded px-2 py-1 ' +
            (mode === 'url' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900')
          }
        >
          URL
        </button>
        <button
          type="button"
          onClick={() => setMode('github')}
          className={
            'rounded px-2 py-1 ' +
            (mode === 'github' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900')
          }
        >
          GitHub
        </button>
      </div>

      {mode === 'url' ? (
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/user/repo.git"
          className="block w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 focus:border-brand-500/60 focus:outline-none"
        />
      ) : !ghStatus.data?.connected ? (
        <p className="text-xs text-neutral-500">
          GitHub App not connected.{' '}
          <Link to="/settings" className="text-brand-500 hover:underline">
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
        <RepoCombobox repos={ghRepos.data} value={selectedGh} onChange={setSelectedGh} />
      ) : (
        <p className="text-xs text-neutral-500">No repos accessible by this installation.</p>
      )}

      <div className="flex gap-2">
        <input
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder={mode === 'github' ? `ref (default: ${defaultRefHint})` : 'branch / ref (optional)'}
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-200 focus:border-brand-500/60 focus:outline-none"
        />
        <button
          type="submit"
          disabled={add.isPending || (mode === 'url' ? !url.trim() : !selectedGh)}
          className="rounded bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {add.isPending ? 'Cloning…' : 'Add repo'}
        </button>
      </div>
      {err && <div className="text-xs text-red-400">{err}</div>}
    </form>
  )
}
