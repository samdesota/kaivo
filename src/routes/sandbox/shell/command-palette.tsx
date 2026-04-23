import { useEffect, useMemo, useRef, useState } from 'react'
import { trpc } from '../../../trpc'
import { extractTrpcMessage } from '../../../lib/utils'
import { type PaneContent } from './tab-state'

interface PaletteItem {
  id: string
  /** Primary label rendered in the palette row. */
  label: string
  /** Secondary, smaller text (path, port detail, etc). */
  detail?: string
  /** Short tag shown on the right (file/shell/preview/action). */
  kind: 'file' | 'shell' | 'preview' | 'action'
  /** Combined text used for fuzzy matching. */
  haystack: string
  /** Selected → run this. */
  run: () => void | Promise<void>
}

/**
 * Cmd-K command palette for the sandbox. Aggregates files, running shells,
 * running previews, and a couple of actions into one searchable list. The
 * caller controls whether it's open via `open`/`onClose`; binding cmd-k is
 * the parent's job (so the palette can be triggered from anywhere).
 */
export function CommandPalette({
  sandboxId,
  open,
  onClose,
  onOpenContent,
  onCloseTab,
  hasActiveTab,
}: {
  sandboxId: string
  open: boolean
  onClose: () => void
  onOpenContent: (content: PaneContent) => void
  onCloseTab: () => void
  hasActiveTab: boolean
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Reset on each open so the user starts fresh.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      // Focus after the modal mounts; rAF avoids a race with React's commit.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Pull all the data the palette can act on. Queries are cheap (cached),
  // so it's fine to fire even while the palette is closed — keeps things
  // snappy on first open.
  const files = trpc.fs.find.useQuery(
    { sandboxId },
    { enabled: open, staleTime: 30_000 },
  )
  const shells = trpc.shell.list.useQuery(
    { sandboxId },
    { enabled: open, staleTime: 5_000 },
  )
  const ports = trpc.preview.portsSnapshot.useQuery(
    { sandboxId },
    { enabled: open, staleTime: 5_000 },
  )
  const utils = trpc.useUtils()
  const createShell = trpc.shell.create.useMutation()

  const items: PaletteItem[] = useMemo(() => {
    const out: PaletteItem[] = []

    // Actions first (always visible, but ranked by query like everything else).
    out.push({
      id: 'action:new-shell',
      label: 'New shell',
      detail: 'Open a new terminal in the sandbox',
      kind: 'action',
      haystack: 'new shell terminal',
      run: async () => {
        try {
          const info = await createShell.mutateAsync({ sandboxId })
          await utils.shell.list.invalidate({ sandboxId })
          onOpenContent({ type: 'shell', shellId: info.id })
        } catch (e) {
          // surface in console; palette closes anyway
          console.error('new shell failed', extractTrpcMessage(e))
        }
      },
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

    for (const s of shells.data ?? []) {
      out.push({
        id: `shell:${s.id}`,
        label: `shell ${s.id.slice(-8)}`,
        detail: `cwd ${s.cwd}${s.ownerKind === 'agent' ? ' · agent' : ''}`,
        kind: 'shell',
        haystack: `shell ${s.id} ${s.cwd}`,
        run: () => onOpenContent({ type: 'shell', shellId: s.id }),
      })
    }

    for (const p of ports.data ?? []) {
      out.push({
        id: `preview:${p.port}`,
        label: `:${p.port}`,
        detail: `${p.process ?? 'unknown'} · ${p.address}`,
        kind: 'preview',
        haystack: `preview port ${p.port} ${p.process ?? ''} ${p.address}`,
        run: () => onOpenContent({ type: 'preview', port: p.port }),
      })
    }

    for (const path of files.data?.paths ?? []) {
      // Paths come in workspace-relative form (e.g. "/src/foo.ts"). Drop
      // the leading slash for display so the label reads naturally.
      const display = path.replace(/^\/+/, '')
      out.push({
        id: `file:${path}`,
        label: display.split('/').pop() ?? display,
        detail: display,
        kind: 'file',
        haystack: display,
        run: () => onOpenContent({ type: 'file', path }),
      })
    }

    return out
  }, [files.data, shells.data, ports.data, hasActiveTab, sandboxId, onOpenContent, onCloseTab, utils, createShell])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      // No query: prefer actions + recent things first; cap to keep it scannable.
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

  // Clamp active index when the filtered list shrinks below it.
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
          placeholder="Search files, shells, previews…"
          className="w-full border-b border-neutral-800 bg-neutral-950 px-4 py-3 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none"
        />
        <ul className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-4 py-3 text-xs text-neutral-500">
              {files.isLoading || shells.isLoading || ports.isLoading
                ? 'Loading…'
                : 'No matches.'}
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
    kind === 'file'
      ? 'border-neutral-700 text-neutral-400'
      : kind === 'shell'
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

/**
 * Subsequence fuzzy match. Returns 0 when the query isn't a subsequence of
 * the haystack, otherwise a score that rewards consecutive matches and
 * matches near the start. Tiny but good enough for ~5k files.
 */
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
        // Boundary bonus (path segment / extension).
        score += 4
      }
      qi += 1
    } else {
      streak = 0
    }
    hi += 1
  }
  if (qi < q.length) return 0
  // Penalize long haystacks slightly so shorter paths win on ties.
  return score - haystack.length * 0.005
}
