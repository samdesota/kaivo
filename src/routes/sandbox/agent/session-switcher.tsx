import { useEffect, useRef, useState } from 'react'
import { trpc } from '../../../trpc'
import { extractTrpcMessage } from '../../../lib/utils'

/**
 * Agent session switcher + "+ New session" affordance. Selecting a session
 * swaps the transcript in place (caller rekeys TranscriptPane on sessionId
 * change). New-session opens a small modal for an optional title + initial
 * prompt.
 */
export function SessionSwitcher({
  sandboxId,
  sessionId,
  onSelect,
}: {
  sandboxId: string
  sessionId: string | null
  onSelect: (sessionId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [modal, setModal] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const sessions = trpc.agent.sessionList.useQuery(
    { sandboxId },
    { refetchInterval: 5_000 },
  )

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return
      if (!ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const current = sessions.data?.find((s) => s.id === sessionId)
  const label = current?.title ?? (sessionId ? sessionId.slice(-6) : 'No session')

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
      >
        <span className="max-w-[220px] truncate">{label}</span>
        <span className="text-neutral-500">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-80 rounded border border-neutral-800 bg-neutral-950 shadow-lg">
          <button
            onClick={() => {
              setModal(true)
              setOpen(false)
            }}
            className="flex w-full items-center gap-2 border-b border-neutral-800 px-3 py-1.5 text-left text-xs text-brand-400 hover:bg-neutral-900"
          >
            <span>+ New session</span>
          </button>
          {sessions.isLoading && (
            <div className="px-3 py-2 text-xs text-neutral-500">Loading…</div>
          )}
          {sessions.data && sessions.data.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500">No sessions yet.</div>
          )}
          {sessions.data?.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                onSelect(s.id)
                setOpen(false)
              }}
              className={
                'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-neutral-900 ' +
                (s.id === sessionId ? 'bg-neutral-900' : '')
              }
            >
              <span className="min-w-0 flex-1 truncate text-neutral-200">
                {s.title ?? s.id.slice(-8)}
              </span>
              <span className="shrink-0 text-[10px] text-neutral-500">
                {new Date(s.lastActivityAt).toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      )}
      {modal && (
        <NewSessionModal
          sandboxId={sandboxId}
          onClose={() => setModal(false)}
          onCreated={(id) => {
            setModal(false)
            onSelect(id)
          }}
        />
      )}
    </div>
  )
}

function NewSessionModal({
  sandboxId,
  onClose,
  onCreated,
}: {
  sandboxId: string
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [directory, setDirectory] = useState<string>('')
  const [err, setErr] = useState<string | null>(null)
  const start = trpc.agent.sessionStart.useMutation()
  const repos = trpc.repo.list.useQuery({ sandboxId })

  // Default to the first repo when the list loads (common case: one repo).
  useEffect(() => {
    if (directory) return
    const first = repos.data?.[0]
    if (first) setDirectory(first.workspacePath)
  }, [directory, repos.data])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    const msg = prompt.trim()
    try {
      const res = await start.mutateAsync({
        sandboxId,
        prompt: msg || undefined,
        title: title.trim() || undefined,
        directory: directory || undefined,
      })
      onCreated(res.id)
    } catch (e2) {
      setErr(extractTrpcMessage(e2))
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
        className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-950 p-4 shadow-xl"
      >
        <h2 className="mb-3 text-sm font-semibold text-neutral-100">New agent session</h2>
        <label className="mb-2 block text-[11px] uppercase tracking-wide text-neutral-500">
          Title (optional)
        </label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. fix auth bug"
          className="mb-3 block w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-brand-500/60 focus:outline-none"
        />
        <label className="mb-2 block text-[11px] uppercase tracking-wide text-neutral-500">
          Working directory
        </label>
        <select
          value={directory}
          onChange={(e) => setDirectory(e.target.value)}
          className="mb-3 block w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-brand-500/60 focus:outline-none"
        >
          <option value="">(no repo — /workspace)</option>
          {repos.data?.map((r) => (
            <option key={r.id} value={r.workspacePath}>
              {r.slug} — {r.workspacePath}
            </option>
          ))}
        </select>
        <label className="mb-2 block text-[11px] uppercase tracking-wide text-neutral-500">
          Initial prompt (optional)
        </label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder="Leave blank to start empty and use the composer."
          autoFocus
          className="mb-3 block w-full resize-none rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 focus:border-brand-500/60 focus:outline-none"
        />
        {err && <div className="mb-3 text-xs text-red-400">{err}</div>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={start.isPending}
            className="rounded bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-60"
          >
            {start.isPending ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}
