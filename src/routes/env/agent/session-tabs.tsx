import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { BorderedTabStrip, type BorderedTabItem } from '../../../components/bordered-tab-strip'
import { envTrpc } from '../../../env-trpc'
import { trpcQueryKey } from '../../../lib/trpc-plain'
import { openFolderPickerOverlay } from '../../../lib/overlay-layer-controller'
import { extractTrpcMessage } from '../../../lib/utils'
import { useWorkspaceAgentTabsStore } from '../../workspace/agent-tabs-store'
import { useEnv } from '../env-context'
import { NewAgentChatOverlayLauncher } from './new-agent-chat-modal'

interface SessionSummary {
  id: string
  title: string | null
  status: string
  createdAt: Date | string
  lastActivityAt: Date | string
}

interface RepoRow {
  id: string
  slug: string
  workspacePath: string
}

export function SessionTabs({
  workspaceId,
  sessionId,
  onSelect,
  onOpenNewChat,
}: {
  workspaceId?: string
  sessionId: string | null
  onSelect: (sessionId: string) => void
  onOpenNewChat?: () => void | Promise<void>
}) {
  const sessionListInput = workspaceId ? { workspaceId } : undefined
  const sessions = envTrpc.agent.sessionList.useQuery(sessionListInput, {
    refetchInterval: 5_000,
  })
  const queryClient = useQueryClient()
  const close = envTrpc.agent.sessionClose.useMutation()
  const reopen = envTrpc.agent.sessionReopen.useMutation()
  const agentTabs = useWorkspaceAgentTabsStore(workspaceId)

  const sessionsData = sessions.data as SessionSummary[] | undefined
  const { active, archived } = useMemo(() => {
    const act: SessionSummary[] = []
    const arc: SessionSummary[] = []
    for (const s of sessionsData ?? []) {
      if (s.status === 'archived') arc.push(s)
      else act.push(s)
    }
    if (!workspaceId) return { active: act, archived: arc }

    const byId = new Map(act.map((session) => [session.id, session]))
    const ordered: SessionSummary[] = []
    for (const tab of agentTabs.records) {
      const session = byId.get(tab.sessionId)
      if (!session) continue
      ordered.push(session)
      byId.delete(tab.sessionId)
    }
    const missing = [...byId.values()].sort((a, b) => {
      const created = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      return created || a.id.localeCompare(b.id)
    })
    return { active: [...ordered, ...missing], archived: arc }
  }, [agentTabs.records, sessionsData, workspaceId])

  useEffect(() => {
    if (!workspaceId) return
    for (const session of active) agentTabs.ensureSession(session.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, workspaceId])

  async function onClose(id: string) {
    const others = active.filter((s) => s.id !== id)
    try {
      await close.mutateAsync({ sessionId: id })
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList', sessionListInput) })
      agentTabs.deleteSession(id)
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
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList', sessionListInput) })
      agentTabs.ensureSession(id)
      onSelect(id)
    } catch {
      /* ignore */
    }
  }

  const tabItems: BorderedTabItem[] = active.map((s) => ({
    id: s.id,
    label: s.title ?? s.id.slice(-6),
    title: new Date(s.lastActivityAt).toLocaleString(),
    closeTitle: 'Close session',
  }))

  return (
    <div className="flex min-w-0 flex-1 items-stretch">
      <BorderedTabStrip
        items={tabItems}
        activeId={sessionId}
        onSelect={onSelect}
        onClose={(id) => void onClose(id)}
      />
      {!workspaceId && <NewSessionPopover workspaceId={workspaceId} onCreated={onSelect} onOpenNewChat={onOpenNewChat} />}
      {archived.length > 0 && (
        <ClosedDropdown archived={archived} onReopen={onReopen} />
      )}
    </div>
  )
}

export function NewSessionPopover({
  workspaceId,
  onCreated,
  label = '+',
  variant = 'compact',
  onOpenNewChat,
}: {
  workspaceId?: string
  onCreated: (sessionId: string) => void
  label?: string
  variant?: 'compact' | 'cta'
  onOpenNewChat?: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const envContext = useEnv()
  const repos = envTrpc.repo.list.useQuery(undefined, { enabled: open })
  const start = envTrpc.agent.sessionStart.useMutation()
  const queryClient = useQueryClient()
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  if (workspaceId) {
    return (
      <div className="relative shrink-0">
        <button
          onClick={() => {
            if (onOpenNewChat) void onOpenNewChat()
            else setOpen(true)
          }}
          disabled={start.isPending}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-neutral-800 bg-neutral-950/90 text-neutral-500 shadow hover:bg-neutral-900 hover:text-neutral-300 disabled:opacity-50"
          title="New agent chat"
          aria-label="New agent chat"
        >
          {start.isPending ? <span className="h-3 w-3 animate-spin rounded-full border border-running border-t-transparent" /> : <Plus className="h-3 w-3" aria-hidden="true" />}
        </button>
        <NewAgentChatOverlayLauncher
          open={open}
          workspaceId={workspaceId}
          onClose={() => setOpen(false)}
          onCreated={onCreated}
        />
      </div>
    )
  }

  async function createIn(directory?: string) {
    setErr(null)
    try {
      const res = (await start.mutateAsync({ workspaceId, directory })) as { id: string }
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList', workspaceId ? { workspaceId } : undefined) })
      onCreated(res.id)
      setOpen(false)
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  async function chooseFolder() {
    setOpen(false)
    const path = await openFolderPickerOverlay({
      env: envContext.env,
      envToken: envContext.envToken,
      busy: start.isPending,
    })
    if (path) await createIn(path)
  }

  const trigger =
    variant === 'cta' ? (
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={start.isPending}
        className="rounded-md bg-neutral-700 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-neutral-600"
      >
        {start.isPending ? 'Creating…' : label}
      </button>
    ) : (
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={start.isPending}
        className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded border border-neutral-800 bg-neutral-950/90 px-1 text-neutral-500 shadow hover:bg-neutral-900 hover:text-neutral-300 disabled:opacity-50"
        title="New agent session"
        aria-label="New session"
      >
        {start.isPending ? <span className="h-3 w-3 animate-spin rounded-full border border-running border-t-transparent" /> : label === '+' ? <Plus className="h-3 w-3" aria-hidden="true" /> : label}
      </button>
    )

  const repoRows = (repos.data as RepoRow[] | undefined) ?? []

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
          {repoRows.map((r) => (
            <button
              key={r.id}
              onClick={() => void createIn(r.workspacePath)}
              disabled={start.isPending}
              className="flex w-full flex-col items-start px-3 py-1.5 text-left text-xs hover:bg-highlight disabled:opacity-60"
            >
              <span className="text-neutral-200">{r.slug}</span>
              <span className="font-mono text-[10px] text-neutral-500">{r.workspacePath}</span>
            </button>
          ))}
          <button
            onClick={() => {
              void chooseFolder()
            }}
            disabled={start.isPending}
            className="flex w-full items-center gap-2 border-t border-neutral-800 px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-highlight disabled:opacity-60"
          >
            <span>Choose folder…</span>
          </button>
          <button
            onClick={() => void createIn(undefined)}
            disabled={start.isPending}
            className="flex w-full items-center gap-2 border-t border-neutral-800 px-3 py-1.5 text-left text-xs text-neutral-400 hover:bg-highlight disabled:opacity-60"
          >
            <span>(no repo — default working dir)</span>
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
        className="px-2 py-1 text-xs text-neutral-500 hover:text-neutral-200"
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
              className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-highlight"
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
