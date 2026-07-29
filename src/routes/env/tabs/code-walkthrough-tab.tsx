import { useEffect, useState } from 'react'
import type { CanonicalDiff } from '../../../../packages/env-server/src/walkthrough/contracts'
import {
  DEFAULT_WALKTHROUGH_MAX_INPUT_BYTES,
  estimateWalkthroughInputBytes,
} from '../../../../shared/walkthrough-input'
import { envTrpc } from '../../../env-trpc'
import {
  GitComparisonControls,
  defaultGitDiffComparison,
  gitDiffInput,
  resolvedOriginBranch,
  type GitDiffComparison,
} from './git-comparison'
import { WalkthroughDocument } from './walkthrough-document'

export function CodeWalkthroughTab({
  cwd,
  walkthroughId,
  onWalkthroughIdChange,
  onRepositoryRootChange,
}: {
  cwd: string
  walkthroughId?: string
  onWalkthroughIdChange: (walkthroughId: string) => void
  onRepositoryRootChange?: (root: string) => void
}) {
  const [comparison, setComparison] = useState<GitDiffComparison>(defaultGitDiffComparison)
  const repositoryQuery = envTrpc.git.discoverGit.useQuery({ cwd }, { refetchOnWindowFocus: false, retry: false })
  const repository = repositoryQuery.data
  const root = repository?.root ?? cwd
  const branchesQuery = envTrpc.git.originBranches.useQuery(
    { cwd: root },
    { enabled: !!repository, refetchOnWindowFocus: false, retry: false },
  )
  const defaultBranchName = branchesQuery.data?.defaultBranch?.name ?? null
  const selectedBranchName = resolvedOriginBranch(comparison, defaultBranchName)
  const canCompare = !!repository && (comparison.kind === 'working-tree' || (!!repository.headOid && !!selectedBranchName))
  const diffQuery = envTrpc.git.diff.useQuery(gitDiffInput(root, comparison, defaultBranchName), {
    enabled: !walkthroughId && canCompare,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const start = envTrpc.walkthrough.start.useMutation()
  const cancel = envTrpc.walkthrough.cancel.useMutation()
  const snapshot = envTrpc.walkthrough.snapshot.useQuery(
    { walkthroughId: walkthroughId ?? '' },
    { enabled: !!walkthroughId, refetchOnWindowFocus: false, retry: false },
  )
  const [projection, setProjection] = useState<WalkthroughProjection>()

  useEffect(() => {
    if (!walkthroughId) setProjection(undefined)
    else if (snapshot.data) setProjection(snapshot.data)
  }, [snapshot.data, walkthroughId])

  envTrpc.walkthrough.events.useSubscription(
    { walkthroughId: walkthroughId ?? '', afterSeq: snapshot.data?.sequence ?? 0 },
    {
      enabled: !!walkthroughId && !!snapshot.data && !isTerminalStatus(snapshot.data.status),
      onData(event) {
        setProjection((current) => applyWalkthroughEvent(current ?? snapshot.data, event))
      },
    },
  )

  useEffect(() => {
    if (repository?.root && repository.root !== cwd) onRepositoryRootChange?.(repository.root)
  }, [cwd, onRepositoryRootChange, repository?.root])

  if (walkthroughId) {
    return (
      <WalkthroughRead
        snapshot={projection ?? snapshot.data}
        loading={snapshot.isLoading}
        error={snapshot.error}
        cancelling={cancel.isPending}
        onCancel={() => cancel.mutate({ walkthroughId })}
      />
    )
  }

  const diff = diffQuery.data
  const unavailable = comparison.kind === 'branch' && (!repository?.headOid || !selectedBranchName)
  const estimatedInputBytes = diff
    ? estimateWalkthroughInputBytes({ patchByteCount: diff.byteCount, files: diff.files })
    : 0
  const inputTooLarge = estimatedInputBytes > DEFAULT_WALKTHROUGH_MAX_INPUT_BYTES
  const cannotGenerate = !diff || diff.files.length === 0 || diff.truncated || inputTooLarge || unavailable || start.isPending
  const error = repositoryQuery.error ?? branchesQuery.error ?? diffQuery.error ?? start.error

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-975" aria-label="Configure Code Walkthrough">
      <header className="shrink-0 border-b border-neutral-800 bg-neutral-950/95 px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <GitComparisonControls
            comparison={comparison}
            branches={branchesQuery.data?.branches ?? []}
            defaultBranchName={defaultBranchName}
            selectedBranchName={selectedBranchName}
            onComparisonChange={setComparison}
          />
          <div className="min-w-0 flex-1" />
          {diff && <span className="text-[11px] tabular-nums text-neutral-500">{diff.files.length} {diff.files.length === 1 ? 'file' : 'files'} <span className="text-emerald-300">+{diff.additions}</span> <span className="text-red-300">-{diff.deletions}</span></span>}
          <button
            type="button"
            disabled={cannotGenerate}
            onClick={() => {
              start.mutate({
                requestKey: createRequestKey(),
                cwd: root,
                comparison,
              }, { onSuccess: (result) => onWalkthroughIdChange(result.walkthroughId) })
            }}
            className="h-7 rounded bg-sky-700 px-3 text-xs font-medium text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {start.isPending ? 'Generating...' : 'Generate walkthrough'}
          </button>
        </div>
      </header>
      {error ? <WalkthroughMessage role="alert" title="Unable to configure walkthrough">{errorMessage(error)}</WalkthroughMessage>
        : repositoryQuery.isLoading ? <WalkthroughMessage title="Finding repository...">Loading repository details.</WalkthroughMessage>
          : !repository ? <WalkthroughMessage title="Not a Git repository">No repository was found from <code>{cwd}</code>.</WalkthroughMessage>
            : unavailable ? <WalkthroughMessage title="Comparison unavailable">Choose Working tree or an available origin branch.</WalkthroughMessage>
                : diffQuery.isLoading ? <WalkthroughMessage title="Loading changes...">Capturing the selected comparison.</WalkthroughMessage>
                  : diff?.truncated ? <WalkthroughMessage role="alert" title="Diff is too large">Truncated comparisons cannot produce a complete walkthrough.</WalkthroughMessage>
                    : inputTooLarge ? <WalkthroughMessage role="alert" title="Diff is too large for a walkthrough">This comparison would exceed the safe model input limit. Narrow the comparison before generating.</WalkthroughMessage>
                  : diff && diff.files.length === 0 ? <WalkthroughMessage title="No changes">Choose a comparison containing changes.</WalkthroughMessage>
                    : <WalkthroughMessage title="Ready to generate">The walkthrough will freeze this comparison and include every changed file.</WalkthroughMessage>}
    </div>
  )
}

type WalkthroughProjection = {
  canonical: CanonicalDiff
  markdown: string
  status: string
  warnings: string[]
  coverage: { covered: number; total: number; missing: number }
  error: string | null
  sequence: number
}

function WalkthroughRead({ snapshot, loading, error, cancelling, onCancel }: {
  snapshot?: WalkthroughProjection
  loading: boolean
  error: unknown
  cancelling: boolean
  onCancel: () => void
}) {
  if (loading) return <div className="h-full bg-neutral-975"><WalkthroughMessage title="Loading walkthrough...">Restoring the frozen document.</WalkthroughMessage></div>
  if (error || !snapshot) return <div className="h-full bg-neutral-975"><WalkthroughMessage role="alert" title="Walkthrough unavailable">{errorMessage(error)}</WalkthroughMessage></div>
  const terminal = isTerminalStatus(snapshot.status)
  const coveragePercent = snapshot.coverage.total === 0
    ? 0
    : Math.round((snapshot.coverage.covered / snapshot.coverage.total) * 100)
  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-975" aria-label="Code Walkthrough">
      <header className="flex shrink-0 items-center gap-3 border-b border-neutral-800 bg-neutral-950/95 px-3 py-2 text-xs">
        <span className="font-medium capitalize text-neutral-200">{snapshot.status}</span>
        <span className="text-neutral-500">Coverage <span className="tabular-nums text-neutral-300">{snapshot.coverage.covered}/{snapshot.coverage.total} ({coveragePercent}%)</span></span>
        {snapshot.coverage.missing > 0 && <span className="text-amber-300">{snapshot.coverage.missing} missing</span>}
        <div className="flex-1" />
        {!terminal && <button type="button" disabled={cancelling} onClick={onCancel} className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-900 disabled:opacity-50">{cancelling ? 'Cancelling...' : 'Cancel'}</button>}
      </header>
      {snapshot.warnings.map((warning, index) => <div key={`${index}:${warning}`} role="status" className="border-b border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">{warning}</div>)}
      {snapshot.error && <div role="alert" className="border-b border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200">{snapshot.error}</div>}
      <article className="prose-agent min-h-0 flex-1 overflow-auto px-5 py-4 text-sm leading-relaxed text-content-strong [overflow-wrap:anywhere]">
        <WalkthroughDocument markdown={snapshot.markdown} canonical={snapshot.canonical} />
      </article>
    </div>
  )
}

function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function applyWalkthroughEvent(
  current: WalkthroughProjection | undefined,
  event: { sequence: number; type: string; data: unknown },
): WalkthroughProjection | undefined {
  if (!current || event.sequence <= current.sequence) return current
  const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
  const next = { ...current, sequence: event.sequence }
  if (event.type === 'status.changed' && typeof data.status === 'string') next.status = data.status
  if (event.type === 'markdown.appended' && typeof data.markdown === 'string') next.markdown += data.markdown
  if (event.type === 'coverage.changed'
    && typeof data.covered === 'number' && typeof data.total === 'number' && typeof data.missing === 'number') {
    next.coverage = { covered: data.covered, total: data.total, missing: data.missing }
  }
  if (event.type === 'warning' && typeof data.warning === 'string') next.warnings = [...next.warnings, data.warning]
  if (event.type === 'failed') {
    next.status = 'failed'
    if (typeof data.error === 'string') next.error = data.error
  }
  if (event.type === 'cancelled') next.status = 'cancelled'
  if (event.type === 'completed') next.status = 'completed'
  return next
}

function WalkthroughMessage({ title, children, role }: { title: string; children: React.ReactNode; role?: 'alert' }) {
  return <div role={role} className="flex min-h-0 flex-1 items-center justify-center p-6"><div className="max-w-md text-center"><h2 className="text-sm font-medium text-neutral-200">{title}</h2><div className="mt-1 text-xs leading-5 text-neutral-500">{children}</div></div></div>
}

function createRequestKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `walkthrough-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return 'The walkthrough could not be loaded.'
}
