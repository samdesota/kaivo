import { useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from '../../../components/ui'
import { envTrpc } from '../../../env-trpc'
import { extractTrpcMessage } from '../../../lib/utils'

/**
 * Folder picker for the new-session flow. Browses directories under the
 * env's $HOME ∪ CC_WORKING_DIR (server-enforced) and returns the
 * absolute path of the selected folder. Defaults to the env's working
 * dir on open.
 *
 * Keyboard:
 *   ↑ / ↓   move highlight
 *   →       drill into highlighted folder
 *   ←       go to parent
 *   Enter   select the current folder
 *   Esc     close (handled by Modal)
 *
 * The text filter narrows the list by case-insensitive substring; the
 * highlight resets to the top whenever the filter or the current path
 * changes.
 */
export function FolderPickerModal({
  open,
  onClose,
  onSelect,
  busy,
  title = 'Choose working folder',
}: {
  open: boolean
  onClose: () => void
  onSelect: (absPath: string) => void
  busy?: boolean
  title?: string
}) {
  // `undefined` means "let the server pick the default" (= CC_WORKING_DIR).
  const [path, setPath] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState('')
  const [highlightIdx, setHighlightIdx] = useState(0)
  const filterRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  const browse = envTrpc.fs.browseHome.useQuery(
    { path },
    { enabled: open, refetchOnWindowFocus: false },
  )
  const data = browse.data
  const err = browse.error ? extractTrpcMessage(browse.error) : null

  // Reset to defaults each time the modal opens so the user starts in a
  // predictable place rather than wherever they last left off.
  useEffect(() => {
    if (open) {
      setPath(undefined)
      setFilter('')
      setHighlightIdx(0)
      // Focus the filter input so typing immediately narrows the list.
      // Slight delay so the modal has mounted.
      requestAnimationFrame(() => filterRef.current?.focus())
    }
  }, [open])

  // Reset highlight whenever the directory or filter changes — the
  // previous index almost certainly points at a different entry now.
  useEffect(() => {
    setHighlightIdx(0)
  }, [data?.path, filter])

  const filtered = useMemo(() => {
    if (!data) return []
    const f = filter.trim().toLowerCase()
    if (!f) return data.dirs
    return data.dirs.filter((d) => d.name.toLowerCase().includes(f))
  }, [data, filter])

  function go(absPath: string | null | undefined) {
    if (!absPath) return
    setPath(absPath)
    setFilter('')
  }

  function onKey(e: React.KeyboardEvent) {
    if (!data) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIdx((i) => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIdx((i) => Math.max(0, i - 1))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      const target = filtered[highlightIdx]
      if (target) go(target.path)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      go(data.parent)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onSelect(data.path)
    }
  }

  // Keep the highlighted row in view as ↑/↓ moves past the visible
  // edge of the scroll container.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const el = list.querySelector<HTMLElement>(`[data-idx="${highlightIdx}"]`)
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [highlightIdx])

  return (
    <Modal open={open} onClose={onClose} title={title} widthClass="max-w-lg">
      <div className="space-y-3" onKeyDown={onKey}>
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => go(data?.defaultPath)}
            disabled={!data}
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
            title={data?.defaultPath}
          >
            ⌂ default
          </button>
          <button
            type="button"
            onClick={() => go(data?.home)}
            disabled={!data}
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
            title={data?.home}
          >
            ~ home
          </button>
          <button
            type="button"
            onClick={() => go(data?.parent)}
            disabled={!data?.parent}
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            ↑ up
          </button>
          <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-400">
            {data?.path ?? '…'}
          </div>
        </div>

        <input
          ref={filterRef}
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          className="w-full rounded border border-neutral-800 bg-input px-2 py-1 text-xs text-neutral-100 placeholder:text-placeholder focus:border-neutral-600 focus:outline-none"
        />

        <div
          ref={listRef}
          className="max-h-80 overflow-auto rounded border border-neutral-800 bg-neutral-900/40"
        >
          {browse.isLoading && (
            <div className="px-3 py-2 text-xs text-neutral-500">Loading…</div>
          )}
          {err && <div className="px-3 py-2 text-xs text-red-300">{err}</div>}
          {data && filtered.length === 0 && !browse.isLoading && (
            <div className="px-3 py-2 text-xs text-neutral-500">
              {filter ? 'No matches.' : '(no subdirectories)'}
            </div>
          )}
          {filtered.map((d, idx) => {
            const active = idx === highlightIdx
            return (
              <div
                key={d.path}
                data-idx={idx}
                onClick={() => setHighlightIdx(idx)}
                onDoubleClick={() => go(d.path)}
                className={
                  'flex cursor-pointer items-center gap-2 border-b border-neutral-900 px-3 py-1.5 text-xs last:border-b-0 ' +
                  (active
                    ? 'bg-highlight text-neutral-50'
                    : 'text-neutral-200 hover:bg-highlight')
                }
                title={d.path}
              >
                <span className="text-neutral-500">📁</span>
                <span className="flex-1 truncate">{d.name}</span>
                {active && (
                  <span className="shrink-0 text-[10px] text-neutral-500">→ enter</span>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="truncate font-mono text-[11px] text-neutral-500">
            Selected: {data?.path ?? '…'}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => data && onSelect(data.path)}
              disabled={!data || busy}
              className="rounded bg-neutral-700 px-3 py-1 text-xs font-medium text-white hover:bg-neutral-600 disabled:opacity-60"
            >
              {busy ? 'Starting…' : 'Use this folder'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
