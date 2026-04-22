import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { trpc } from '../../trpc'
import { extractTrpcMessage } from '../../lib/utils'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '../../../server/trpc/router'

type GhRepo = inferRouterOutputs<AppRouter>['github']['listOrgRepos'][number]

type Mode = 'url' | 'github'

export function ReposPanel({ sandboxId }: { sandboxId: string }) {
  const utils = trpc.useUtils()
  const list = trpc.repo.list.useQuery({ sandboxId }, { refetchInterval: 5_000 })
  const add = trpc.repo.add.useMutation()
  const remove = trpc.repo.remove.useMutation()
  const ghStatus = trpc.github.status.useQuery()
  const ghRepos = trpc.github.listOrgRepos.useQuery(undefined, {
    enabled: Boolean(ghStatus.data?.installed),
  })

  const [mode, setMode] = useState<Mode>('url')
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [selectedGh, setSelectedGh] = useState<string>('')
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  async function onAdd() {
    setFormError(null)
    try {
      if (mode === 'url') {
        if (!url.trim()) return
        const { jobId } = await add.mutateAsync({
          source: 'url',
          sandboxId,
          url: url.trim(),
          ref: ref.trim() || undefined,
        })
        setActiveJobId(jobId)
        setUrl('')
        setRef('')
      } else {
        if (!selectedGh) return
        const { jobId } = await add.mutateAsync({
          source: 'github',
          sandboxId,
          repoFullName: selectedGh,
          ref: ref.trim() || undefined,
        })
        setActiveJobId(jobId)
        setSelectedGh('')
        setRef('')
      }
      await utils.repo.list.invalidate({ sandboxId })
    } catch (err) {
      setFormError(extractTrpcMessage(err))
    }
  }

  async function onRemove(repoId: string, slug: string) {
    if (!confirm(`Remove repo "${slug}"? Workspace files will be deleted.`)) return
    try {
      await remove.mutateAsync({ sandboxId, repoId })
      await utils.repo.list.invalidate({ sandboxId })
    } catch (err) {
      setFormError(extractTrpcMessage(err))
    }
  }

  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Repos</h3>
      </div>

      <div className="rounded border border-neutral-800 bg-neutral-900 p-3 space-y-2">
        <div className="flex gap-2 text-xs">
          <button
            onClick={() => setMode('url')}
            className={
              'rounded px-2 py-1 ' +
              (mode === 'url' ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-800')
            }
          >
            URL
          </button>
          <button
            onClick={() => setMode('github')}
            className={
              'rounded px-2 py-1 ' +
              (mode === 'github' ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-800')
            }
          >
            GitHub
          </button>
        </div>
        {mode === 'url' ? (
          <div className="space-y-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 focus:border-brand-500 focus:outline-none"
            />
            <input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="branch or tag (optional)"
              className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 focus:border-brand-500 focus:outline-none"
            />
          </div>
        ) : (
          <div className="space-y-2">
            {!ghStatus.data?.connected ? (
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
              <RepoCombobox
                repos={ghRepos.data}
                value={selectedGh}
                onChange={setSelectedGh}
              />
            ) : (
              <p className="text-xs text-neutral-500">No repos accessible by this installation.</p>
            )}
            <input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder={`ref (default: ${
                ghRepos.data?.find((r) => r.fullName === selectedGh)?.defaultBranch ?? 'main'
              })`}
              className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 focus:border-brand-500 focus:outline-none"
            />
          </div>
        )}

        <button
          onClick={() => void onAdd()}
          disabled={
            add.isPending ||
            (mode === 'url' ? !url.trim() : !selectedGh)
          }
          className="w-full rounded bg-brand-500 px-2 py-1 text-xs font-medium text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {add.isPending ? 'Cloning…' : 'Add repo'}
        </button>

        {formError && <p className="text-xs text-red-400">{formError}</p>}
      </div>

      {activeJobId && <JobProgress jobId={activeJobId} onDone={() => setActiveJobId(null)} />}

      {list.data && list.data.length > 0 ? (
        <ul className="space-y-1 text-xs">
          {list.data.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900 px-2 py-1"
            >
              <div className="min-w-0 flex-1 truncate">
                <div className="truncate font-medium text-neutral-200">{r.slug}</div>
                <div className="truncate text-neutral-500">
                  {r.source === 'github' ? r.githubFullName : r.originUrl} · {r.ref}
                </div>
              </div>
              <button
                onClick={() => void onRemove(r.id, r.slug)}
                className="ml-2 text-neutral-500 hover:text-red-400"
                title="Remove repo"
                disabled={remove.isPending}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-neutral-600">No repos yet.</p>
      )}
    </div>
  )
}

function JobProgress({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const job = trpc.job.get.useQuery({ id: jobId }, { refetchInterval: 1_000 })
  const [logs, setLogs] = useState<string[]>([])

  trpc.job.watch.useSubscription(
    { jobId },
    {
      onData: (u) => {
        if (u.type === 'log') {
          setLogs((prev) => {
            const next = [...prev, `[${u.entry.level}] ${u.entry.message}`]
            return next.length > 50 ? next.slice(next.length - 50) : next
          })
        }
      },
      onError: () => {
        // ignore; polling will catch us up
      },
    },
  )

  const state = job.data?.state ?? 'pending'
  const done = state === 'succeeded' || state === 'failed' || state === 'cancelled'

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900 p-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-neutral-300">
          clone: <span className="font-medium">{state}</span>
          {job.data?.progressPct != null && state === 'running'
            ? ` (${job.data.progressPct}%)`
            : ''}
        </span>
        {done && (
          <button className="text-neutral-500 hover:text-neutral-300" onClick={onDone}>
            dismiss
          </button>
        )}
      </div>
      {job.data?.error && <div className="mt-1 text-red-400">{job.data.error}</div>}
      {logs.length > 0 && (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[10px] text-neutral-500">
          {logs.join('\n')}
        </pre>
      )}
    </div>
  )
}

const MAX_VISIBLE = 30

export function RepoCombobox({
  repos,
  value,
  onChange,
}: {
  repos: GhRepo[]
  value: string
  onChange: (v: string) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const selected = useMemo(
    () => repos.find((r) => r.fullName === value) ?? null,
    [repos, value],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return repos.slice(0, MAX_VISIBLE)
    // Simple substring match on fullName + description; matches in repo name
    // outrank matches in owner.
    const scored: Array<{ r: GhRepo; score: number }> = []
    for (const r of repos) {
      const full = r.fullName.toLowerCase()
      const [owner, name] = full.split('/') as [string, string]
      let score = -1
      if (name.startsWith(q)) score = 3
      else if (name.includes(q)) score = 2
      else if (full.includes(q)) score = 1
      else if ((r.description ?? '').toLowerCase().includes(q)) score = 0
      if (score >= 0) scored.push({ r, score })
      void owner
    }
    scored.sort((a, b) => b.score - a.score || a.r.fullName.localeCompare(b.r.fullName))
    return scored.slice(0, MAX_VISIBLE).map((s) => s.r)
  }, [repos, query])

  // Clamp active index when the filtered list changes.
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(0)
  }, [filtered.length, activeIdx])

  // Scroll the active option into view.
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.children[activeIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  function commit(r: GhRepo) {
    onChange(r.fullName)
    setQuery('')
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      if (open && filtered[activeIdx]) {
        e.preventDefault()
        commit(filtered[activeIdx])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  if (selected) {
    return (
      <div className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs">
        <span className="font-mono text-neutral-200 truncate">{selected.fullName}</span>
        {selected.private && (
          <span className="rounded bg-neutral-800 px-1 text-[10px] text-neutral-400">private</span>
        )}
        <button
          className="ml-auto text-neutral-500 hover:text-neutral-300"
          onClick={() => {
            onChange('')
            setTimeout(() => inputRef.current?.focus(), 0)
          }}
          title="Change"
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          setActiveIdx(0)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        placeholder={`Search ${repos.length} repos…`}
        className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 focus:border-brand-500 focus:outline-none"
      />
      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-auto rounded border border-neutral-800 bg-neutral-950 shadow-lg"
        >
          {filtered.map((r, i) => (
            <li
              key={r.id}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => {
                // mousedown (not click) so it fires before input onBlur.
                e.preventDefault()
                commit(r)
              }}
              className={
                'cursor-pointer px-2 py-1 text-xs ' +
                (i === activeIdx ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300')
              }
            >
              <div className="flex items-center gap-2">
                <span className="truncate font-mono">{r.fullName}</span>
                {r.private && (
                  <span className="rounded bg-neutral-800 px-1 text-[10px] text-neutral-500">
                    private
                  </span>
                )}
              </div>
              {r.description && (
                <div className="truncate text-[10px] text-neutral-500">{r.description}</div>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && query.trim() && filtered.length === 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-500">
          No matches.
        </div>
      )}
    </div>
  )
}
