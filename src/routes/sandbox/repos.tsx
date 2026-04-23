import { useEffect, useMemo, useRef, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '../../../server/trpc/router'

type GhRepo = inferRouterOutputs<AppRouter>['github']['listOrgRepos'][number]

const MAX_VISIBLE = 30

export function RepoCombobox({
  repos,
  value,
  onChange,
}: {
  repos: GhRepo[]
  value: string
  onChange: (v: string) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const selected = useMemo(
    () => repos.find((r) => r.fullName === value) ?? null,
    [repos, value],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return repos.slice(0, MAX_VISIBLE)
    const scored: Array<{ r: GhRepo; score: number }> = []
    for (const r of repos) {
      const full = r.fullName.toLowerCase()
      const [, name] = full.split('/') as [string, string]
      let score = -1
      if (name.startsWith(q)) score = 3
      else if (name.includes(q)) score = 2
      else if (full.includes(q)) score = 1
      else if ((r.description ?? '').toLowerCase().includes(q)) score = 0
      if (score >= 0) scored.push({ r, score })
    }
    scored.sort((a, b) => b.score - a.score || a.r.fullName.localeCompare(b.r.fullName))
    return scored.slice(0, MAX_VISIBLE).map((s) => s.r)
  }, [repos, query])

  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(0)
  }, [filtered.length, activeIdx])

  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.children[activeIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  function commit(r: GhRepo) {
    onChange(r.fullName)
    setQuery('')
    setOpen(false)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActiveIdx((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      if (open && filtered[activeIdx]) {
        e.preventDefault()
        commit(filtered[activeIdx])
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  if (selected) {
    return (
      <div className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs">
        <span className="font-mono text-neutral-200 truncate">{selected.fullName}</span>
        {selected.private && (
          <span className="rounded bg-neutral-800 px-1 text-[10px] text-neutral-400">private</span>
        )}
        <button
          className="ml-auto text-neutral-500 hover:text-neutral-300"
          onClick={() => {
            onChange('')
            setTimeout(() => inputRef.current?.focus(), 0)
          }}
          title="Change"
        >
          ×
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          setActiveIdx(0)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        placeholder={`Search ${repos.length} repos…`}
        className="w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 focus:border-brand-500 focus:outline-none"
      />
      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-auto rounded border border-neutral-800 bg-neutral-950 shadow-lg"
        >
          {filtered.map((r, i) => (
            <li
              key={r.id}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                commit(r)
              }}
              className={
                'cursor-pointer px-2 py-1 text-xs ' +
                (i === activeIdx ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300')
              }
            >
              <div className="flex items-center gap-2">
                <span className="truncate font-mono">{r.fullName}</span>
                {r.private && (
                  <span className="rounded bg-neutral-800 px-1 text-[10px] text-neutral-500">
                    private
                  </span>
                )}
              </div>
              {r.description && (
                <div className="truncate text-[10px] text-neutral-500">{r.description}</div>
              )}
            </li>
          ))}
        </ul>
      )}
      {open && query.trim() && filtered.length === 0 && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-500">
          No matches.
        </div>
      )}
    </div>
  )
}
