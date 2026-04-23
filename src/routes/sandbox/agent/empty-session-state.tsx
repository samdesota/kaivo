import { useState } from 'react'
import { trpc } from '../../../trpc'
import { extractTrpcMessage } from '../../../lib/utils'
import { RepoCloneModal } from '../repo-clone-modal'

/**
 * Shown in the Agents pane when a sandbox has no active sessions. Lists
 * any repos already cloned into the sandbox as clickable cards. The
 * "Clone a repo" CTA opens the global clone modal — there is no longer
 * an inline add-repo form here.
 */
export function EmptySessionState({
  sandboxId,
  onCreated,
}: {
  sandboxId: string
  onCreated: (sessionId: string) => void
}) {
  const utils = trpc.useUtils()
  const repos = trpc.repo.list.useQuery({ sandboxId }, { refetchInterval: 5_000 })
  const start = trpc.agent.sessionStart.useMutation()
  const [err, setErr] = useState<string | null>(null)
  const [cloneOpen, setCloneOpen] = useState(false)

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
            Pick a repo to start a new agent session in, or clone one.
          </p>
        </div>

        <section className="space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Repos</div>
          {repos.isLoading && <div className="text-xs text-neutral-500">Loading repos…</div>}
          {repos.data && repos.data.length === 0 && (
            <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-500">
              This sandbox has no repos yet.
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
          <div className="flex flex-col gap-1 pt-1">
            <button
              onClick={() => setCloneOpen(true)}
              className="rounded border border-dashed border-neutral-700 px-3 py-2 text-left text-xs text-neutral-300 hover:border-brand-500/60 hover:text-neutral-100"
            >
              + Clone a repo
            </button>
            <button
              onClick={() => void createIn(undefined)}
              disabled={start.isPending}
              className="rounded border border-dashed border-neutral-800 px-3 py-2 text-left text-xs text-neutral-500 hover:border-neutral-700 hover:text-neutral-300 disabled:opacity-60"
            >
              Start without a repo — work in <span className="font-mono">/workspace</span>
            </button>
          </div>
        </section>

        {err && (
          <div className="rounded border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">
            {err}
          </div>
        )}
      </div>

      <RepoCloneModal
        sandboxId={sandboxId}
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        onCloned={() => {
          void utils.repo.list.invalidate({ sandboxId })
        }}
      />
    </div>
  )
}
