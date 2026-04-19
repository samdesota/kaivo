import { useEffect, useRef, useState } from 'react'
import { trpc } from '../../../trpc'

/**
 * Simple dropdown listing agent sessions for a sandbox, newest first. In
 * Phase 5 this is read-only; Phase 6 adds a "+ New session" affordance.
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
    </div>
  )
}
