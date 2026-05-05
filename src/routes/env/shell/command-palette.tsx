import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { envTrpc } from '../../../env-trpc'
import { trpcQueryKey } from '../../../lib/trpc-plain'
import { extractTrpcMessage } from '../../../lib/utils'
import { type PaneContent } from './tab-state'

interface PaletteItem {
  id: string
  label: string
  detail?: string
  kind: 'shell' | 'preview' | 'action'
  haystack: string
  run: () => void | Promise<void>
}

interface ShellRow {
  id: string
  cwd: string
  ownerKind?: string
}
interface PortRow {
  port: number
  process?: string | null
  address: string
}
interface ShellCreateResult {
  id: string
}

interface AgentSessionRow {
  id: string
  workingDir: string | null
}

export function CommandPalette({
  open,
  onClose,
  onOpenContent,
  onCloseTab,
  hasActiveTab,
  activeSessionId,
  workspaceId,
}: {
  open: boolean
  onClose: () => void
  onOpenContent: (content: PaneContent) => void
  onCloseTab: () => void
  hasActiveTab: boolean
  /** Currently focused agent session — its workingDir becomes the cwd
   * for any shell created here. */
  activeSessionId?: string | null
  workspaceId?: string
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const workspaceInput = useMemo(() => workspaceId ? { workspaceId } : undefined, [workspaceId])
  const shells = envTrpc.shell.list.useQuery(workspaceInput, {
    enabled: open,
    staleTime: 5_000,
  })
  const ports = envTrpc.preview.portsSnapshot.useQuery(undefined, {
    enabled: open,
    staleTime: 5_000,
  })
  const queryClient = useQueryClient()
  const createShell = envTrpc.shell.create.useMutation()
  const createShellAsync = createShell.mutateAsync
  const sessions = envTrpc.agent.sessionList.useQuery(workspaceInput, {
    enabled: open,
    staleTime: 5_000,
  })
  const sessionRows = (sessions.data ?? []) as AgentSessionRow[]
  const activeCwd =
    (activeSessionId
      ? sessionRows.find((s) => s.id === activeSessionId)?.workingDir
      : null) ?? undefined

  const items: PaletteItem[] = useMemo(() => {
    const out: PaletteItem[] = []

    out.push({
      id: 'action:new-shell',
      label: 'New shell',
      detail: 'Open a new terminal in the env',
      kind: 'action',
      haystack: 'new shell terminal',
      run: async () => {
        try {
          const info = (await createShellAsync(
            { ...workspaceInput, ...(activeCwd ? { cwd: activeCwd } : {}) },
          )) as ShellCreateResult
          await queryClient.invalidateQueries({ queryKey: trpcQueryKey('shell.list', workspaceInput) })
          onOpenContent({ type: 'shell', shellId: info.id })
        } catch (e) {
          console.error('new shell failed', extractTrpcMessage(e))
        }
      },
    })
    out.push({
      id: 'action:new-tab',
      label: 'New tab',
      detail: 'Open Google in a browser tab',
      kind: 'action',
      haystack: 'new tab browser google',
      run: () => onOpenContent({ type: 'browser', url: 'https://www.google.com' }),
    })
    if (hasActiveTab) {
      out.push({
        id: 'action:close-tab',
        label: 'Close current tab',
        kind: 'action',
        haystack: 'close current tab',
        run: () => onCloseTab(),
      })
    }

    for (const s of (shells.data as ShellRow[] | undefined) ?? []) {
      out.push({
        id: `shell:${s.id}`,
        label: `shell ${s.id.slice(-8)}`,
        detail: `cwd ${s.cwd}${s.ownerKind === 'agent' ? ' · agent' : ''}`,
        kind: 'shell',
        haystack: `shell ${s.id} ${s.cwd}`,
        run: () => onOpenContent({ type: 'shell', shellId: s.id }),
      })
    }

    for (const p of (ports.data as PortRow[] | undefined) ?? []) {
      out.push({
        id: `preview:${p.port}`,
        label: `:${p.port}`,
        detail: `${p.process ?? 'unknown'} · ${p.address}`,
        kind: 'preview',
        haystack: `preview port ${p.port} ${p.process ?? ''} ${p.address}`,
        run: () => onOpenContent({ type: 'preview', port: p.port }),
      })
    }

    return out
  }, [shells.data, ports.data, hasActiveTab, onOpenContent, onCloseTab, queryClient, createShellAsync, activeCwd, workspaceInput])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      const actions = items.filter((i) => i.kind === 'action')
      const live = items.filter((i) => i.kind === 'shell' || i.kind === 'preview')
      return [...actions, ...live].slice(0, 200)
    }
    const scored: Array<{ item: PaletteItem; score: number }> = []
    for (const it of items) {
      const score = fuzzyScore(it.haystack.toLowerCase(), q)
      if (score > 0) scored.push({ item: it, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 200).map((s) => s.item)
  }, [items, query])

  useEffect(() => {
    if (active >= filtered.length) setActive(0)
  }, [filtered.length, active])

  if (!open) return null

  function pick(i: number) {
    const item = filtered[i]
    if (!item) return
    void item.run()
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              onClose()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(filtered.length - 1, a + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(0, a - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              pick(active)
            }
          }}
          placeholder="Search shells, previews, actions…"
          className="w-full border-b border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
        />
        <ul className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-4 py-3 text-xs text-neutral-500">
              {shells.isLoading || ports.isLoading ? 'Loading…' : 'No matches.'}
            </li>
          ) : (
            filtered.map((it, i) => (
              <li
                key={it.id}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(i)}
                className={
                  'flex cursor-pointer items-center gap-3 px-4 py-1.5 text-sm ' +
                  (i === active ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300')
                }
              >
                <KindBadge kind={it.kind} />
                <span className="truncate">{it.label}</span>
                {it.detail && (
                  <span className="ml-auto truncate text-[11px] text-neutral-500">
                    {it.detail}
                  </span>
                )}
              </li>
            ))
          )}
        </ul>
        <div className="flex items-center gap-3 border-t border-neutral-800 px-4 py-1.5 text-[10px] text-neutral-500">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span className="ml-auto">{filtered.length} result{filtered.length === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>
  )
}

function KindBadge({ kind }: { kind: PaletteItem['kind'] }) {
  const cls =
    kind === 'shell'
      ? 'border-emerald-700 text-emerald-400'
      : kind === 'preview'
        ? 'border-sky-700 text-sky-400'
        : 'border-brand-500/40 text-brand-400'
  return (
    <span
      className={`inline-block rounded border px-1 py-[1px] text-[9px] uppercase tracking-wide ${cls}`}
    >
      {kind}
    </span>
  )
}

function fuzzyScore(haystack: string, q: string): number {
  if (!q) return 0
  let hi = 0
  let qi = 0
  let score = 0
  let streak = 0
  while (hi < haystack.length && qi < q.length) {
    if (haystack[hi] === q[qi]) {
      streak += 1
      score += 1 + streak * 2
      if (hi === 0 || haystack[hi - 1] === '/' || haystack[hi - 1] === '.') {
        score += 4
      }
      qi += 1
    } else {
      streak = 0
    }
    hi += 1
  }
  if (qi < q.length) return 0
  return score - haystack.length * 0.005
}
