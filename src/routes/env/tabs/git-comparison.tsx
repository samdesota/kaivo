import { useId, useState } from 'react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter as EnvAppRouter } from '../../../../packages/env-server/src/trpc/router'

export type OriginBranch = inferRouterOutputs<EnvAppRouter>['git']['originBranches']['branches'][number]

export type GitDiffBranchComparison = { kind: 'branch'; originBranch: string | null; includeUncommitted: boolean }

export type GitDiffComparison =
  | GitDiffBranchComparison
  | { kind: 'working-tree'; branch: GitDiffBranchComparison }

export const defaultGitDiffComparison: GitDiffComparison = {
  kind: 'branch',
  originBranch: null,
  includeUncommitted: true,
}

export function branchComparisonPreference(comparison: GitDiffComparison): GitDiffBranchComparison {
  return comparison.kind === 'branch' ? comparison : comparison.branch
}

export function resolvedOriginBranch(comparison: GitDiffComparison, defaultBranchName?: string | null): string | null {
  return branchComparisonPreference(comparison).originBranch ?? defaultBranchName ?? null
}

export function gitDiffInput(cwd: string, comparison: GitDiffComparison, defaultBranchName?: string | null) {
  if (comparison.kind === 'working-tree') return { cwd, kind: 'working-tree' as const }
  return {
    cwd,
    kind: 'branch' as const,
    originBranch: resolvedOriginBranch(comparison, defaultBranchName) ?? '',
    includeUncommitted: comparison.includeUncommitted,
  }
}

export function GitComparisonControls({
  comparison,
  branches,
  defaultBranchName,
  selectedBranchName,
  onComparisonChange,
}: {
  comparison: GitDiffComparison
  branches: OriginBranch[]
  defaultBranchName: string | null
  selectedBranchName: string | null
  onComparisonChange: (comparison: GitDiffComparison) => void
}) {
  const branchPreference = branchComparisonPreference(comparison)
  return (
    <>
      <select
        aria-label="Comparison mode"
        value={comparison.kind}
        onChange={(event) => onComparisonChange(event.target.value === 'working-tree'
          ? { kind: 'working-tree', branch: branchPreference }
          : branchPreference)}
        className="h-7 rounded border border-neutral-800 bg-input px-2 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
      >
        <option value="branch">Branch changes</option>
        <option value="working-tree">Working tree</option>
      </select>
      {comparison.kind === 'branch' && (
        <>
          <OriginBranchCombobox
            branches={branches}
            value={selectedBranchName}
            defaultBranchName={defaultBranchName}
            onChange={(originBranch) => onComparisonChange({ ...comparison, originBranch })}
          />
          <label className="flex h-7 items-center gap-1.5 whitespace-nowrap rounded border border-neutral-800 px-2 text-[11px] text-neutral-300">
            <input
              type="checkbox"
              checked={comparison.includeUncommitted}
              onChange={(event) => onComparisonChange({ ...comparison, includeUncommitted: event.target.checked })}
              className="h-3 w-3 accent-neutral-200"
            />
            Include uncommitted
          </label>
        </>
      )}
    </>
  )
}

function OriginBranchCombobox({ branches, value, defaultBranchName, onChange }: {
  branches: OriginBranch[]
  value: string | null
  defaultBranchName: string | null
  onChange: (branch: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listboxId = useId()
  const filtered = branches.filter((branch) => branch.name.toLowerCase().includes(query.trim().toLowerCase()))
  const commit = (branch: OriginBranch) => {
    onChange(branch.name)
    setOpen(false)
    setQuery('')
  }
  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Base origin branch"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="h-7 min-w-28 rounded border border-neutral-800 bg-input px-2 text-left font-mono text-[11px] text-neutral-200 focus:border-neutral-600 focus:outline-none"
      >
        origin/{value ?? 'select...'} ▾
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 w-64 rounded border border-neutral-800 bg-neutral-950 p-1 shadow-xl">
          <input
            autoFocus
            role="combobox"
            aria-label="Search origin branches"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-activedescendant={filtered[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, filtered.length - 1)) }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)) }
              else if (event.key === 'Enter' && filtered[activeIndex]) { event.preventDefault(); commit(filtered[activeIndex]) }
              else if (event.key === 'Escape') setOpen(false)
            }}
            placeholder="Search branches..."
            className="mb-1 w-full rounded border border-neutral-800 bg-input px-2 py-1 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
          />
          <ul id={listboxId} role="listbox" aria-label="Origin branches" className="max-h-56 overflow-auto">
            {filtered.map((branch, index) => (
              <li
                id={`${listboxId}-${index}`}
                key={branch.ref}
                role="option"
                aria-selected={branch.name === value}
                onMouseDown={(event) => { event.preventDefault(); commit(branch) }}
                onMouseEnter={() => setActiveIndex(index)}
                className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs ${index === activeIndex ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-300'}`}
              >
                <span className="min-w-0 flex-1 truncate font-mono">origin/{branch.name}</span>
                {branch.name === defaultBranchName && <span className="text-[10px] text-neutral-500">default</span>}
              </li>
            ))}
          </ul>
          {filtered.length === 0 && <div className="px-2 py-1 text-xs text-neutral-500">No matching branches.</div>}
        </div>
      )}
    </div>
  )
}
