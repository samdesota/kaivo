import { useState } from 'react'
import { envTrpc } from '../../../env-trpc'
import { extractTrpcMessage } from '../../../lib/utils'
import { FolderPickerModal } from './folder-picker-modal'
import { NewAgentChatModal } from './new-agent-chat-modal'

interface RepoRow {
  id: string
  slug: string
  workspacePath: string
}

/**
 * Shown in the Agents pane when an env has no active sessions. Lists any
 * repos already present in the env as clickable cards. Cloning new repos
 * isn't wired up for envs yet — tell the user to clone from a shell.
 */
export function EmptySessionState({
  workspaceId,
  onCreated,
}: {
  workspaceId?: string
  onCreated: (sessionId: string) => void
}) {
  const repos = envTrpc.repo.list.useQuery(undefined, { refetchInterval: 5_000 })
  const start = envTrpc.agent.sessionStart.useMutation()
  const [err, setErr] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  if (workspaceId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <div>
          <h2 className="text-lg font-semibold text-neutral-100">No chats yet</h2>
          <p className="mt-1 text-sm text-neutral-400">Start a new agent chat from a folder or repo config.</p>
        </div>
        <button
          onClick={() => setPickerOpen(true)}
          className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600"
        >
          Start a new agent chat
        </button>
        <NewAgentChatModal
          open={pickerOpen}
          workspaceId={workspaceId}
          onClose={() => setPickerOpen(false)}
          onCreated={onCreated}
        />
      </div>
    )
  }

  async function createIn(directory?: string) {
    setErr(null)
    try {
      const res = (await start.mutateAsync({ workspaceId, directory })) as { id: string }
      onCreated(res.id)
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  const repoRows = (repos.data as RepoRow[] | undefined) ?? []

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
      <div className="mx-auto w-full max-w-md space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-neutral-100">No sessions yet</h2>
          <p className="mt-1 text-sm text-neutral-400">
            Pick a working dir to start a new agent session.
          </p>
        </div>

        <section className="space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">Repos</div>
          {repos.isLoading && <div className="text-xs text-neutral-500">Loading repos…</div>}
          {repos.data && repoRows.length === 0 && (
            <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-500">
              No repos registered in this env. Clone one from a shell:{' '}
              <code className="font-mono">git clone &lt;url&gt;</code>
            </div>
          )}
          {repoRows.map((r) => (
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
              onClick={() => setPickerOpen(true)}
              disabled={start.isPending}
              className="rounded border border-dashed border-neutral-800 px-3 py-2 text-left text-xs text-neutral-300 hover:border-brand-500/60 hover:text-neutral-100 disabled:opacity-60"
            >
              Choose folder…
            </button>
            <button
              onClick={() => void createIn(undefined)}
              disabled={start.isPending}
              className="rounded border border-dashed border-neutral-800 px-3 py-2 text-left text-xs text-neutral-500 hover:border-neutral-700 hover:text-neutral-300 disabled:opacity-60"
            >
              Start in the env's default working dir
            </button>
          </div>
        </section>

        {err && (
          <div className="rounded border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-300">
            {err}
          </div>
        )}
      </div>
      <FolderPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        busy={start.isPending}
        onSelect={(absPath) => {
          setPickerOpen(false)
          void createIn(absPath)
        }}
      />
    </div>
  )
}
