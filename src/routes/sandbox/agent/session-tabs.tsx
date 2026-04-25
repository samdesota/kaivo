import { useEffect, useMemo, useRef, useState } from 'react'
import { trpc } from '../../../trpc'
import { extractTrpcMessage } from '../../../lib/utils'

/**
 * Horizontal session tab bar. One tab per ACTIVE session, each with an ×
 * close button that archives the session. Archived sessions live in a
 * `Closed ▾` dropdown on the right and can be reopened from there.
 *
 * Session creation: click `+` to open a repo picker; selecting an entry
 * creates an empty session anchored in that repo. The session's title is
 * filled in from the truncated first prompt when the user sends their
 * opening message via the composer.
 */
export function SessionTabs({
  sandboxId,
  sessionId,
  onSelect,
}: {
  sandboxId: string
  sessionId: string | null
  onSelect: (sessionId: string) => void
}) {
  const sessions = trpc.agent.sessionList.useQuery(
    { sandboxId },
    { refetchInterval: 5_000 },
  )
  const utils = trpc.useUtils()
  const close = trpc.agent.sessionClose.useMutation()
  const reopen = trpc.agent.sessionReopen.useMutation()

  const sessionsData = sessions.data
  const { active, archived } = useMemo(() => {
    const act: NonNullable<typeof sessionsData> = []
    const arc: NonNullable<typeof sessionsData> = []
    for (const s of sessionsData ?? []) {
      if (s.status === 'archived') arc.push(s)
      else act.push(s)
    }
    return { active: act, archived: arc }
  }, [sessionsData])

  async function onClose(id: string) {
    const others = active.filter((s) => s.id !== id)
    try {
      await close.mutateAsync({ sessionId: id })
      await utils.agent.sessionList.invalidate({ sandboxId })
      if (id === sessionId) {
        const next = others[0]?.id
        if (next) onSelect(next)
      }
    } catch {
      /* ignore */
    }
  }

  async function onReopen(id: string) {
    try {
      await reopen.mutateAsync({ sessionId: id })
      await utils.agent.sessionList.invalidate({ sandboxId })
      onSelect(id)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {/* The session tabs themselves scroll horizontally. The `+` button
          lives OUTSIDE this container so its popover isn't clipped by
          overflow-x-auto. */}
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {active.map((s) => {
          const selected = s.id === sessionId
          const label = s.title ?? s.id.slice(-6)
          return (
            <div
              key={s.id}
              className={
                'group flex shrink-0 items-center gap-0.5 rounded transition-colors ' +
                (selected ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200')
              }
            >
              <button
                onClick={() => onSelect(s.id)}
                className="py-1 pl-2 pr-1 text-xs"
                title={new Date(s.lastActivityAt).toLocaleString()}
              >
                <span className="max-w-[180px] truncate align-middle">{label}</span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void onClose(s.id)
                }}
                className="mr-1 rounded px-1 text-[11px] leading-none text-neutral-500 opacity-70 hover:bg-neutral-700 hover:text-neutral-100 hover:opacity-100"
                aria-label="Close session"
                title="Close session"
              >
                ×
              </button>
            </div>
          )
        })}
      </div>
      <NewSessionPopover sandboxId={sandboxId} onCreated={onSelect} />
      {archived.length > 0 && (
        <ClosedDropdown archived={archived} onReopen={onReopen} />
      )}
    </div>
  )
}

export function NewSessionPopover({
  sandboxId,
  onCreated,
  label = '+',
  variant = 'compact',
}: {
  sandboxId: string
  onCreated: (sessionId: string) => void
  label?: string
  variant?: 'compact' | 'cta'
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const repos = trpc.repo.list.useQuery({ sandboxId }, { enabled: open })
  const start = trpc.agent.sessionStart.useMutation()
  const utils = trpc.useUtils()
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  async function createIn(directory?: string) {
    setErr(null)
    try {
      const res = await start.mutateAsync({ sandboxId, directory })
      await utils.agent.sessionList.invalidate({ sandboxId })
      onCreated(res.id)
      setOpen(false)
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  const trigger =
    variant === 'cta' ? (
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={start.isPending}
        className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-brand-600"
      >
        {start.isPending ? 'Creating…' : label}
      </button>
    ) : (
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={start.isPending}
        className="shrink-0 rounded px-2 py-1 text-xs text-brand-400 hover:bg-neutral-900 hover:text-brand-300"
        title="New agent session"
        aria-label="New session"
      >
        {start.isPending ? 'Creating…' : label}
      </button>
    )

  return (
    <div ref={ref} className="relative shrink-0">
      {trigger}
      {open && (
        <div
          className={
            'absolute z-30 mt-1 w-72 rounded border border-neutral-800 bg-neutral-950 shadow-lg ' +
            (variant === 'cta' ? 'left-1/2 -translate-x-1/2' : 'left-0')
          }
        >
          <div className="border-b border-neutral-800 px-3 py-1.5 text-[10px] uppercase tracking-wide text-neutral-500">
            New session · pick a working dir
          </div>
          {repos.isLoading && (
            <div className="px-3 py-2 text-xs text-neutral-500">Loading repos…</div>
          )}
          {repos.data?.map((r) => (
            <button
              key={r.id}
              onClick={() => void createIn(r.workspacePath)}
              disabled={start.isPending}
              className="flex w-full flex-col items-start px-3 py-1.5 text-left text-xs hover:bg-neutral-900 disabled:opacity-60"
            >
              <span className="text-neutral-200">{r.slug}</span>
              <span className="font-mono text-[10px] text-neutral-500">{r.workspacePath}</span>
            </button>
          ))}
          <button
            onClick={() => void createIn(undefined)}
            disabled={start.isPending}
            className="flex w-full items-center gap-2 border-t border-neutral-800 px-3 py-1.5 text-left text-xs text-neutral-400 hover:bg-neutral-900 disabled:opacity-60"
          >
            <span>(no repo — /workspace)</span>
          </button>
          {err && <div className="border-t border-red-900 bg-red-950/50 px-3 py-1 text-[11px] text-red-300">{err}</div>}
          {start.isPending && (
            <div className="border-t border-neutral-800 px-3 py-1 text-[11px] text-neutral-500">Creating…</div>
          )}
        </div>
      )}
    </div>
  )
}

interface ArchivedSession {
  id: string
  title: string | null
  lastActivityAt: Date | string
}

function ClosedDropdown({
  archived,
  onReopen,
}: {
  archived: ArchivedSession[]
  onReopen: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
        title="Closed sessions — click to reopen"
      >
        Closed ({archived.length}) ▾
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-80 rounded border border-neutral-800 bg-neutral-950 shadow-lg">
          {archived.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                onReopen(s.id)
                setOpen(false)
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-neutral-900"
            >
              <span className="min-w-0 flex-1 truncate text-neutral-200">
                {s.title ?? s.id.slice(-8)}
              </span>
              <span className="shrink-0 text-[10px] text-neutral-500">
                {new Date(s.lastActivityAt).toLocaleDateString()}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
