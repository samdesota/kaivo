import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter as EnvAppRouter } from '../../../../packages/env-server/src/trpc/router'
import { envTrpc } from '../../../env-trpc'
import { DiffView } from '../agent/parts/diff-view'
import { diffFileId, type DiffFileMetadata } from '../agent/parts/diff-model'
import {
  initialGitDiffState,
  retainGitDiffSnapshot,
  retainGitDiffState,
  retainedGitDiffSnapshot,
  type GitDiffComparison,
} from './git-diff-tab-state'

type GitSnapshot = inferRouterOutputs<EnvAppRouter>['git']['diff']
type OriginBranch = inferRouterOutputs<EnvAppRouter>['git']['originBranches']['branches'][number]

export function GitDiffTab({ cwd, tabId = cwd, onRepositoryRootChange }: { cwd: string; tabId?: string; onRepositoryRootChange?: (root: string) => void }) {
  const envUtils = envTrpc.useUtils()
  const [transient, setTransient] = useState(() => initialGitDiffState(tabId))
  const [retainedSnapshot, setRetainedSnapshot] = useState(() => retainedGitDiffSnapshot<GitSnapshot>(tabId))
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<unknown>(null)
  const refreshVersion = useRef(0)
  const reconciledRoot = useRef(cwd)
  const comparison = transient.comparison
  const branchPreference = comparison.kind === 'branch' ? comparison : comparison.branch

  useEffect(() => retainGitDiffState(tabId, transient), [tabId, transient])

  const repositoryQuery = envTrpc.git.discoverGit.useQuery(
    { cwd },
    { refetchOnWindowFocus: false, retry: false },
  )
  const repository = repositoryQuery.data ?? retainedSnapshot?.repository ?? null

  useEffect(() => {
    const root = repositoryQuery.data?.root
    if (!root || root === reconciledRoot.current) return
    reconciledRoot.current = root
    onRepositoryRootChange?.(root)
  }, [onRepositoryRootChange, repositoryQuery.data?.root])
  const branchesQuery = envTrpc.git.originBranches.useQuery(
    { cwd: repository?.root ?? cwd },
    { enabled: !!repository, refetchOnWindowFocus: false, retry: false },
  )
  const branches = branchesQuery.data
  const selectedBranchName = branchPreference.originBranch ?? branches?.defaultBranch?.name ?? null
  const diffInput = useMemo(() => comparison.kind === 'working-tree'
    ? { cwd: repository?.root ?? cwd, kind: 'working-tree' as const }
    : {
      cwd: repository?.root ?? cwd,
      kind: 'branch' as const,
      originBranch: selectedBranchName ?? '',
      includeUncommitted: comparison.includeUncommitted,
    }, [comparison, cwd, repository?.root, selectedBranchName])
  const canCompare = !!repository && (comparison.kind === 'working-tree'
    || (!!repository.headOid && !!selectedBranchName))
  const diffQuery = envTrpc.git.diff.useQuery(diffInput, {
    enabled: canCompare,
    refetchOnWindowFocus: false,
    retry: false,
  })

  useEffect(() => {
    if (!canCompare || !diffQuery.data) return
    retainGitDiffSnapshot(tabId, diffQuery.data)
    setRetainedSnapshot(diffQuery.data)
  }, [canCompare, diffQuery.data, tabId])

  function updateComparison(next: GitDiffComparison) {
    refreshVersion.current += 1
    setRefreshing(false)
    setRefreshError(null)
    setTransient((current) => ({ ...current, comparison: next }))
  }

  async function refresh() {
    const version = ++refreshVersion.current
    setRefreshing(true)
    setRefreshError(null)
    try {
      const freshRepository = await envUtils.git.discoverGit.fetch({ cwd })
      if (!freshRepository) throw new Error(`Repository is no longer available from ${cwd}.`)
      if (version !== refreshVersion.current) return
      if (freshRepository.root !== reconciledRoot.current) {
        reconciledRoot.current = freshRepository.root
        onRepositoryRootChange?.(freshRepository.root)
      }
      const freshBranches = await envUtils.git.originBranches.fetch({ cwd: freshRepository.root })
      if (version !== refreshVersion.current) return
      let input: typeof diffInput | null
      if (comparison.kind === 'working-tree') {
        input = { cwd: freshRepository.root, kind: 'working-tree' }
      } else {
        const branchName = comparison.originBranch ?? freshBranches.defaultBranch?.name ?? null
        input = freshRepository.headOid && branchName
          ? { cwd: freshRepository.root, kind: 'branch', originBranch: branchName, includeUncommitted: comparison.includeUncommitted }
          : null
      }
      if (!input) return
      const snapshot = await envUtils.git.diff.fetch(input)
      if (version !== refreshVersion.current) return
      retainGitDiffSnapshot(tabId, snapshot)
      setRetainedSnapshot(snapshot)
    } catch (error) {
      if (version === refreshVersion.current) setRefreshError(error)
    } finally {
      if (version === refreshVersion.current) setRefreshing(false)
    }
  }

  if (repositoryQuery.isLoading) return <GitDiffLoading />
  if (repositoryQuery.error && !retainedSnapshot) return <GitDiffError title={errorTitle(repositoryQuery.error)} error={repositoryQuery.error} onRetry={refresh} />
  if (!repository) {
    return (
      <GitDiffState title="Not a Git repository" action={<RetryButton onClick={refresh} />}>
        No repository was found from <code className="break-all text-neutral-300">{cwd}</code>.
      </GitDiffState>
    )
  }

  const diff = diffQuery.data ?? retainedSnapshot
  const loadingComparison = diffQuery.isLoading || diffQuery.isFetching || refreshing
  const headLabel = repository.branch ?? repository.headOid?.slice(0, 8) ?? 'Unborn HEAD'
  const baseLabel = comparison.kind === 'working-tree' ? 'working tree' : selectedBranchName ? `origin/${selectedBranchName}` : 'origin branch'
  const noBranches = !branchesQuery.isLoading && (!branches || branches.branches.length === 0)
  const unavailable = comparison.kind === 'branch' && (!repository.headOid || noBranches || !selectedBranchName)

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-975" aria-label="Git Diff">
      <GitDiffToolbar
        comparison={comparison}
        branches={branches?.branches ?? []}
        defaultBranchName={branches?.defaultBranch?.name ?? null}
        selectedBranchName={selectedBranchName}
        headLabel={headLabel}
        diff={diff}
        loading={loadingComparison || branchesQuery.isLoading}
        onComparisonChange={updateComparison}
        onRefresh={() => void refresh()}
      />
      {(refreshError || diffQuery.error || repositoryQuery.error || branchesQuery.error) && diff && (
        <div role="alert" className="shrink-0 border-b border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          {errorMessage(refreshError ?? diffQuery.error ?? repositoryQuery.error ?? branchesQuery.error)}{' '}
          <button type="button" className="underline hover:text-amber-100" onClick={() => void refresh()}>Retry</button>
        </div>
      )}
      {diff?.truncated && (
        <div role="status" className="shrink-0 border-b border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          Diff output was truncated at the output limit. File metadata and aggregate counts are complete; the rendered patch is partial.
        </div>
      )}
      {unavailable ? (
        <GitDiffUnavailable repositoryHasHead={!!repository.headOid} noBranches={noBranches} />
      ) : diffQuery.error && !diff ? (
        <GitDiffError title={errorTitle(diffQuery.error)} error={diffQuery.error} onRetry={refresh} />
      ) : !diff ? (
        <GitDiffLoading label={comparison.kind === 'working-tree' ? 'Loading working tree…' : 'Loading branch changes…'} compact />
      ) : diff.files.length === 0 ? (
        <GitDiffState title="No changes">
          {comparison.kind === 'working-tree'
            ? 'The working tree has no staged, unstaged, or untracked changes.'
            : `${headLabel} has no ${comparison.includeUncommitted ? 'committed or uncommitted' : 'committed'} changes against ${baseLabel}.`}
        </GitDiffState>
      ) : (
        <GitDiffReview
          diff={diff}
          loading={loadingComparison}
          expandedFiles={transient.expandedFiles}
          onExpandedFilesChange={(expandedFiles) => setTransient((current) => ({ ...current, expandedFiles }))}
        />
      )}
    </div>
  )
}

const narrowNavigatorWidth = 420

function GitDiffReview({ diff, loading, expandedFiles, onExpandedFilesChange }: {
  diff: GitSnapshot
  loading: boolean
  expandedFiles: Record<string, boolean>
  onExpandedFilesChange: (expandedFiles: Record<string, boolean>) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const [navigatorWidth, setNavigatorWidth] = useState(240)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(() => diff.files[0] ? diffFileId(diff.files[0], 0) : null)
  const dragging = useRef(false)
  const narrow = containerWidth > 0 && containerWidth < narrowNavigatorWidth

  useLayoutEffect(() => {
    const node = containerRef.current
    if (!node) return
    const update = () => setContainerWidth(node.getBoundingClientRect().width)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const ids = diff.files.map(diffFileId)
    if (!selectedFileId || !ids.includes(selectedFileId)) setSelectedFileId(ids[0] ?? null)
  }, [diff.files, selectedFileId])

  useEffect(() => {
    function move(event: globalThis.PointerEvent) {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      setNavigatorWidth(clampNavigatorWidth(event.clientX - rect.left, rect.width))
    }
    function stop() {
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
  }, [])

  function selectFile(file: DiffFileMetadata, index: number) {
    const id = diffFileId(file, index)
    onExpandedFilesChange({ ...expandedFiles, [id]: true })
    setSelectedFileId(id)
  }

  return (
    <div ref={containerRef} className={`flex min-h-0 flex-1 flex-col transition-opacity ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
      {narrow && <NarrowFileSelector files={diff.files} selectedFileId={selectedFileId} onSelect={selectFile} />}
      <div className="flex min-h-0 flex-1">
        {!narrow && (
          <>
            <aside className="min-h-0 shrink-0 overflow-auto border-r border-neutral-800 bg-neutral-950/45" style={{ width: navigatorWidth }} aria-label="Changed files navigator">
              <div className="sticky top-0 z-10 border-b border-neutral-800 bg-neutral-950 px-3 py-2">
                <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">Changed files</div>
                <AggregateCounts diff={diff} />
              </div>
              <FileList files={diff.files} selectedFileId={selectedFileId} onSelect={selectFile} />
            </aside>
            <div
              role="separator"
              aria-label="Resize changed files navigator"
              aria-orientation="vertical"
              aria-valuemin={180}
              aria-valuemax={Math.max(180, containerWidth - 360)}
              aria-valuenow={Math.round(navigatorWidth)}
              tabIndex={0}
              onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
                event.preventDefault()
                dragging.current = true
                document.body.style.cursor = 'col-resize'
                document.body.style.userSelect = 'none'
              }}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                setNavigatorWidth((width) => clampNavigatorWidth(width + (event.key === 'ArrowLeft' ? -16 : 16), containerWidth))
              }}
              className="z-10 -ml-px w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-neutral-700 focus:bg-sky-700 focus:outline-none"
            />
          </>
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-auto px-2 pb-1">
          <DiffView
            diff={diff.patch}
            files={diff.files}
            truncated={diff.truncated}
            selectedFileId={selectedFileId}
            unbounded
            hideLargeDiffs
            fileExpansion={expandedFiles}
            onFileExpansionChange={(fileId, open) => onExpandedFilesChange({ ...expandedFiles, [fileId]: open })}
          />
        </div>
      </div>
    </div>
  )
}

function NarrowFileSelector({ files, selectedFileId, onSelect }: {
  files: GitSnapshot['files']
  selectedFileId: string | null
  onSelect: (file: GitSnapshot['files'][number], index: number) => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-950/70 px-3 py-2">
      <label htmlFor="git-changed-file" className="sr-only">Changed file</label>
      <select
        id="git-changed-file"
        aria-label="Changed file"
        value={selectedFileId ?? ''}
        onChange={(event) => {
          const index = files.findIndex((file, fileIndex) => diffFileId(file, fileIndex) === event.target.value)
          if (index >= 0) onSelect(files[index]!, index)
        }}
        className="h-7 min-w-0 flex-1 rounded border border-neutral-800 bg-input px-2 font-mono text-[11px] text-neutral-200 focus:border-neutral-600 focus:outline-none"
      >
        {files.map((file, index) => <option key={diffFileId(file, index)} value={diffFileId(file, index)}>{fileLabel(file)}</option>)}
      </select>
      <span className="shrink-0 text-[11px] text-neutral-500">{files.length} {files.length === 1 ? 'file' : 'files'}</span>
    </div>
  )
}

function FileList({ files, selectedFileId, onSelect }: {
  files: GitSnapshot['files']
  selectedFileId: string | null
  onSelect: (file: GitSnapshot['files'][number], index: number) => void
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = index
    if (event.key === 'ArrowDown') next = Math.min(files.length - 1, index + 1)
    else if (event.key === 'ArrowUp') next = Math.max(0, index - 1)
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = files.length - 1
    else return
    event.preventDefault()
    refs.current[next]?.focus()
    refs.current[next]?.scrollIntoView?.({ block: 'nearest' })
    onSelect(files[next]!, next)
  }
  return (
    <div role="listbox" aria-label="Changed files" className="py-1">
      {files.map((file, index) => {
        const id = diffFileId(file, index)
        const selected = id === selectedFileId
        return (
          <button
            key={id}
            ref={(node) => { refs.current[index] = node }}
            type="button"
            role="option"
            aria-selected={selected}
            tabIndex={selected || (!selectedFileId && index === 0) ? 0 : -1}
            onClick={() => onSelect(file, index)}
            onKeyDown={(event) => moveFocus(event, index)}
            className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-[11px] ${selected ? 'bg-sky-950/60 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900/70 hover:text-neutral-200'}`}
          >
            <span className="w-3 shrink-0 pt-px font-semibold" aria-hidden="true">{statusSymbol(file.status)}</span>
            <span className="min-w-0 flex-1">
              <span className="block break-all font-mono leading-4">{fileLabel(file)}</span>
              <span className="flex gap-1.5 text-[10px] tabular-nums">
                {file.binary ? <span className="text-amber-300">Binary</span> : <><span className="text-emerald-300">+{file.additions ?? 0}</span><span className="text-red-300">-{file.deletions ?? 0}</span></>}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function AggregateCounts({ diff }: { diff: GitSnapshot }) {
  return <div className="mt-0.5 text-[10px] tabular-nums text-neutral-500" title="Complete counts from file metadata">{diff.files.length} files <span className="text-emerald-300">+{diff.additions}</span> <span className="text-red-300">-{diff.deletions}</span></div>
}

function fileLabel(file: DiffFileMetadata): string {
  return file.oldPath && (file.status === 'renamed' || file.status === 'copied') ? `${file.oldPath} → ${file.path}` : file.path
}

function statusSymbol(status: DiffFileMetadata['status']): string {
  return { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', untracked: '?' }[status]
}

function clampNavigatorWidth(width: number, containerWidth: number): number {
  return Math.max(180, Math.min(width, Math.max(180, containerWidth - 360)))
}

function GitDiffToolbar({
  comparison,
  branches,
  defaultBranchName,
  selectedBranchName,
  headLabel,
  diff,
  loading,
  onComparisonChange,
  onRefresh,
}: {
  comparison: GitDiffComparison
  branches: OriginBranch[]
  defaultBranchName: string | null
  selectedBranchName: string | null
  headLabel: string
  diff?: GitSnapshot
  loading: boolean
  onComparisonChange: (comparison: GitDiffComparison) => void
  onRefresh: () => void
}) {
  const branchPreference = comparison.kind === 'branch' ? comparison : comparison.branch
  return (
    <header className="z-20 shrink-0 border-b border-neutral-800 bg-neutral-950/95 px-3 py-2 backdrop-blur">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
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
        <div className="min-w-0 flex-1 truncate text-[11px] text-neutral-500" title={`${headLabel} → ${comparison.kind === 'working-tree' ? 'working tree' : `origin/${selectedBranchName ?? '?'}`}`}>
          {headLabel}<span className="mx-1.5 text-neutral-700">→</span>{comparison.kind === 'working-tree' ? 'working tree' : `origin/${selectedBranchName ?? '?'}`}
        </div>
        {diff && (
          <div className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-neutral-500">
            <span>{diff.files.length} {diff.files.length === 1 ? 'file' : 'files'}</span>
            <span className="text-emerald-300">+{diff.additions}</span>
            <span className="text-red-300">-{diff.deletions}</span>
          </div>
        )}
        <button
          type="button"
          aria-label="Refresh Git diff"
          title="Refresh local repository state"
          disabled={loading}
          onClick={onRefresh}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-neutral-800 text-sm text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 disabled:opacity-50"
        >
          ↻
        </button>
      </div>
    </header>
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
        origin/{value ?? 'select…'} ▾
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
            placeholder="Search branches…"
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

function GitDiffUnavailable({ repositoryHasHead, noBranches }: { repositoryHasHead: boolean; noBranches: boolean }) {
  if (!repositoryHasHead) {
    return <GitDiffState title="Unborn HEAD">Choose Working tree to review files before the first commit.</GitDiffState>
  }
  if (noBranches) {
    return <GitDiffState title="No origin branches">Branch comparison requires a local <code className="text-neutral-300">origin/*</code> branch. Working tree remains available.</GitDiffState>
  }
  return <GitDiffState title="No default origin branch">Choose an available origin branch or switch to Working tree.</GitDiffState>
}

function GitDiffLoading({ label = 'Finding repository…', compact = false }: { label?: string; compact?: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-975" aria-label="Git Diff loading">
      {!compact && <div className="h-12 shrink-0 animate-pulse border-b border-neutral-800 bg-neutral-950/70" />}
      <div className="space-y-2 p-3" role="status">
        <div className="text-xs text-neutral-500">{label}</div>
        <div className="h-3 w-2/3 animate-pulse rounded bg-neutral-900" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-neutral-900" />
      </div>
    </div>
  )
}

function GitDiffState({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-neutral-975 p-6">
      <div className="max-w-md text-center">
        <h2 className="text-sm font-medium text-neutral-200">{title}</h2>
        <div className="mt-1 text-xs leading-5 text-neutral-500">{children}</div>
        {action && <div className="mt-3">{action}</div>}
      </div>
    </div>
  )
}

function RetryButton({ onClick }: { onClick: () => void | Promise<void> }) {
  return <button type="button" className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-900" onClick={() => void onClick()}>Retry</button>
}

function GitDiffError({ title, error, onRetry }: { title: string; error: unknown; onRetry: () => void | Promise<void> }) {
  return <div role="alert" className="flex min-h-0 flex-1"><GitDiffState title={title} action={<RetryButton onClick={onRetry} />}>{errorMessage(error)}</GitDiffState></div>
}

function errorTitle(error: unknown): string {
  const message = errorMessage(error).toLowerCase()
  if (message.includes('timed out') || message.includes('timeout')) return 'Git operation timed out'
  if (message.includes('merge base') || message.includes('unrelated')) return 'No merge base'
  if (message.includes('head') && (message.includes('unavailable') || message.includes('unborn'))) return 'HEAD unavailable'
  return 'Git operation failed'
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error && 'message' in error && typeof error.message === 'string') return error.message
  return 'Git could not load this comparison.'
}
