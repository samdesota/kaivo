import { useEffect, useState } from 'react'
import { Modal } from '../../components/ui'
import { trpc } from '../../trpc'
import { extractTrpcMessage } from '../../lib/utils'
import { NewRepoConfigForm, RepoConfigEditor } from './repo-config-manager'

export function RepoCloneModal({
  sandboxId,
  open,
  onClose,
  onCloned,
}: {
  sandboxId: string
  open: boolean
  onClose: () => void
  onCloned?: (repoId: string) => void
}) {
  const utils = trpc.useUtils()
  const configs = trpc.repoConfig.list.useQuery(undefined, { enabled: open })
  const add = trpc.repo.add.useMutation()
  const [selectedId, setSelectedId] = useState<string>('')
  const [refOverride, setRefOverride] = useState('')
  const [creating, setCreating] = useState(false)
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setSelectedId('')
      setRefOverride('')
      setCreating(false)
      setActiveJobId(null)
      setActiveRepoId(null)
      setErr(null)
    }
  }, [open])

  useEffect(() => {
    if (open && configs.data && configs.data.length === 0) setCreating(true)
  }, [open, configs.data])

  // Drop the selection if the underlying config disappears (e.g. deleted from
  // the embedded editor).
  useEffect(() => {
    if (selectedId && configs.data && !configs.data.some((c) => c.id === selectedId)) {
      setSelectedId('')
    }
  }, [selectedId, configs.data])

  async function onClone() {
    setErr(null)
    if (!selectedId) return
    try {
      const res = await add.mutateAsync({
        sandboxId,
        configId: selectedId,
        refOverride: refOverride.trim() || undefined,
      })
      setActiveJobId(res.jobId)
      setActiveRepoId(res.repoId)
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Clone a repo" widthClass="max-w-2xl">
      {activeJobId ? (
        <CloneProgress
          jobId={activeJobId}
          onDone={async () => {
            await utils.repo.list.invalidate({ sandboxId })
            if (activeRepoId) onCloned?.(activeRepoId)
            onClose()
          }}
        />
      ) : creating ? (
        <div className="space-y-3">
          <NewRepoConfigForm
            onCreated={(id) => {
              setSelectedId(id)
              setCreating(false)
            }}
            onCancel={
              configs.data && configs.data.length > 0
                ? () => setCreating(false)
                : undefined
            }
          />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[10px] uppercase tracking-wide text-neutral-500">Config</div>
              <button
                onClick={() => setCreating(true)}
                className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-200 hover:bg-neutral-800"
              >
                + New config
              </button>
            </div>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 focus:border-brand-500/60 focus:outline-none"
            >
              <option value="">— pick a config —</option>
              {configs.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.source === 'github' ? c.githubFullName : c.originUrl})
                </option>
              ))}
            </select>
          </div>

          {selectedId && (
            <>
              <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
                <RepoConfigEditor configId={selectedId} />
              </div>
              <div className="space-y-1">
                <div className="text-[10px] uppercase tracking-wide text-neutral-500">
                  Ref override (optional)
                </div>
                <input
                  value={refOverride}
                  onChange={(e) => setRefOverride(e.target.value)}
                  placeholder="(use config's default ref)"
                  className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100 focus:border-brand-500/60 focus:outline-none"
                />
              </div>
            </>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded border border-neutral-800 px-3 py-1.5 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            >
              Cancel
            </button>
            <button
              onClick={() => void onClone()}
              disabled={!selectedId || add.isPending}
              className="rounded bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {add.isPending ? 'Starting…' : 'Clone into sandbox'}
            </button>
          </div>
          {err && <p className="text-xs text-red-400">{err}</p>}
        </div>
      )}
    </Modal>
  )
}

function CloneProgress({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const job = trpc.job.get.useQuery({ id: jobId }, { refetchInterval: 1_000 })
  const [logs, setLogs] = useState<string[]>([])

  trpc.job.watch.useSubscription(
    { jobId },
    {
      onData: (u) => {
        if (u.type === 'log') {
          setLogs((prev) => {
            const next = [...prev, `[${u.entry.level}] ${u.entry.message}`]
            return next.length > 200 ? next.slice(next.length - 200) : next
          })
        }
      },
      onError: () => {},
    },
  )

  const state = job.data?.state ?? 'pending'
  const done = state === 'succeeded' || state === 'failed' || state === 'cancelled'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="text-neutral-300">
          clone: <span className="font-medium">{state}</span>
          {job.data?.progressPct != null && state === 'running'
            ? ` (${job.data.progressPct}%)`
            : ''}
        </span>
        {done && (
          <button
            onClick={onDone}
            className="rounded bg-brand-500 px-3 py-1 text-xs font-medium text-white hover:bg-brand-600"
          >
            {state === 'succeeded' ? 'Done' : 'Close'}
          </button>
        )}
      </div>
      {job.data?.error && <div className="text-xs text-red-400">{job.data.error}</div>}
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 p-2 text-[10px] text-neutral-400">
        {logs.length === 0 ? '(waiting…)' : logs.join('\n')}
      </pre>
    </div>
  )
}
