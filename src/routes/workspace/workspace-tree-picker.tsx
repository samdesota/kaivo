import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type WorkspaceTreePickerFolder = { id: string; name: string; parentId?: string | null }
export type WorkspaceTreePickerWorkspace = { id: string; name: string; folderId?: string | null }
export type WorkspaceTreePickerNode =
  | { type: 'folder'; folder: WorkspaceTreePickerFolder; children: WorkspaceTreePickerNode[] }
  | { type: 'workspace'; workspace: WorkspaceTreePickerWorkspace }

type PickerMode = 'workspaces' | 'folders'
type FlatPickerRow =
  | { type: 'root'; id: null; name: string; depth: number; searchable: string }
  | { type: 'folder'; id: string; name: string; depth: number; searchable: string }
  | { type: 'workspace'; id: string; name: string; depth: number; searchable: string }

export function WorkspaceTreePicker({
  mode,
  tree,
  selectedId,
  fallbackLabel,
  disabled,
  ariaLabel,
  searchPlaceholder,
  onSelect,
}: {
  mode: PickerMode
  tree: WorkspaceTreePickerNode[]
  selectedId?: string | null
  fallbackLabel: string
  disabled?: boolean
  ariaLabel: string
  searchPlaceholder: string
  onSelect: (id: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(null)
  const rows = useMemo(() => flattenPickerTree(tree, mode), [mode, tree])
  const visibleRows = useMemo(() => filterPickerRows(rows, query), [query, rows])
  const selectedLabel = selectedId == null && mode === 'folders'
    ? 'No folder'
    : rows.find((row) => row.id === selectedId && row.type !== 'root')?.name ?? fallbackLabel

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(event: MouseEvent) {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    function updatePosition() {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      setMenuRect({ top: rect.bottom + 4, left: rect.left, width: rect.width })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  function choose(id: string | null) {
    onSelect(id)
    setOpen(false)
    setQuery('')
  }

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-2 rounded border border-neutral-800 bg-neutral-930 px-3 py-2 text-left text-xs text-neutral-100 outline-none hover:border-neutral-700 disabled:opacity-60"
      >
        <span className="min-w-0 truncate">{selectedLabel}</span>
        <span className="shrink-0 text-neutral-500">v</span>
      </button>
      {open && menuRect && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[70] max-h-80 overflow-hidden rounded border border-neutral-800 bg-neutral-950 shadow-lg"
          style={{ top: menuRect.top, left: menuRect.left, width: menuRect.width }}
        >
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder}
            className="w-full border-b border-neutral-800 bg-transparent px-3 py-2 text-xs text-neutral-100 outline-none placeholder:text-neutral-500"
            autoFocus
          />
          <div className="max-h-64 overflow-y-auto py-1">
            {visibleRows.map((row) => {
              const selectable = row.type === mode.slice(0, -1) || row.type === 'root'
              return (
                <button
                  key={`${row.type}:${row.id ?? 'root'}`}
                  type="button"
                  disabled={!selectable}
                  onClick={() => selectable && choose(row.id)}
                  className={
                    'flex w-full min-w-0 items-center gap-1 px-3 py-1.5 text-left text-xs ' +
                    (selectable ? 'text-neutral-200 hover:bg-neutral-900' : 'cursor-default text-neutral-500')
                  }
                >
                  <span className="shrink-0 text-neutral-700" style={{ width: row.depth * 14 }} aria-hidden="true" />
                  <span className={row.type === 'folder' ? 'truncate font-medium' : 'truncate'}>{row.name}</span>
                </button>
              )
            })}
            {visibleRows.length === 0 && <div className="p-4 text-center text-xs text-neutral-500">No matches.</div>}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function flattenPickerTree(nodes: WorkspaceTreePickerNode[], mode: PickerMode): FlatPickerRow[] {
  const rows: FlatPickerRow[] = mode === 'folders'
    ? [{ type: 'root', id: null, name: 'No folder', depth: 0, searchable: 'No folder' }]
    : []

  function visit(items: WorkspaceTreePickerNode[], depth: number, ancestors: string[]) {
    for (const item of items) {
      if (item.type === 'folder') {
        const searchable = [...ancestors, item.folder.name].join(' ')
        rows.push({ type: 'folder', id: item.folder.id, name: item.folder.name, depth, searchable })
        visit(item.children, depth + 1, [...ancestors, item.folder.name])
      } else if (mode === 'workspaces') {
        rows.push({
          type: 'workspace',
          id: item.workspace.id,
          name: item.workspace.name,
          depth,
          searchable: [...ancestors, item.workspace.name].join(' '),
        })
      }
    }
  }

  visit(nodes, 0, [])
  return rows
}

function filterPickerRows(rows: FlatPickerRow[], query: string): FlatPickerRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  const matches = new Set<FlatPickerRow>()
  rows.forEach((row, index) => {
    if (!row.searchable.toLowerCase().includes(q)) return
    matches.add(row)
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = rows[i]
      if (!candidate) continue
      if (candidate.depth < row.depth) matches.add(candidate)
      if (candidate.depth === 0) break
    }
  })
  return rows.filter((row) => matches.has(row))
}
