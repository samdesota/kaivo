import { useLayoutEffect, useMemo } from 'react'
import { Plus } from 'lucide-react'
import { paneTabIconForType } from '../../../../components/tab-icon'
import { envTrpc } from '../../../../env-trpc'
import { extractTrpcMessage } from '../../../../lib/utils'
import { UniversalMenuHierarchyRow, UniversalMenuResultList, rowClassName, selectResult } from '../shared'
import type { UniversalMenuRenderState, UniversalMenuResult, UniversalScopeModule, UniversalScopeProps } from '../types'
import { disabledRow, displayPath, groupRow } from '../utils'

interface RepoWorktreeRow {
  id: string
  configId?: string | null
  name: string
  slug: string
  worktreeName: string
  worktreeSlug: string
  workingDir: string
  githubFullName: string | null
}

interface RepoConfigRow {
  id: string
  name: string
  originUrl?: string | null
  githubFullName?: string | null
}

export const worktreesScopeModule: UniversalScopeModule = {
  id: 'work-trees',
  label: 'Work Trees',
  key: '#',
  detail: 'Search repo worktrees',
  placeholder: 'Worktree search lands in Task 5',
  Component: WorktreesScope,
}

export function WorktreesScope(props: UniversalScopeProps) {
  const { activeIndex, mouseMoved, onActiveChange, onClose, onMouseMoved, onCreatedChat, openDetails, query, setScopeApi, workspaceId } = props
  const configs = envTrpc.repo.listConfigs.useQuery(undefined, { staleTime: 5_000 })
  const worktrees = envTrpc.repo.listWorktrees.useQuery(undefined, { staleTime: 5_000 })
  const startChat = envTrpc.agent.sessionStart.useMutation()

  const results = useMemo(() => workTreeScopeResults({
    worktrees: worktrees.data as RepoWorktreeRow[] | undefined,
    configs: configs.data as RepoConfigRow[] | undefined,
    loading: worktrees.isLoading,
    configsLoading: configs.isLoading,
    error: worktrees.error,
    configsError: configs.error,
    query,
    workspaceId,
    openNewWorkspaceChat: openDetails,
    startChat: async (path) => {
      if (!workspaceId) return
      const created = await startChat.mutateAsync({ workspaceId, directory: path }) as { id: string }
      onCreatedChat?.(created.id, workspaceId)
    },
  }), [configs.data, configs.error, configs.isLoading, onCreatedChat, openDetails, query, startChat, workspaceId, worktrees.data, worktrees.error, worktrees.isLoading])

  useLayoutEffect(() => {
    setScopeApi({
      resultCount: results.length,
      selectActive: (event) => selectResult(results, activeIndex, onClose, event),
    })
  }, [activeIndex, onClose, results, setScopeApi])

  return (
    <UniversalMenuResultList
      results={results}
      activeIndex={activeIndex}
      mouseMoved={mouseMoved}
      onMouseMoved={onMouseMoved}
      onActiveChange={onActiveChange}
      onSelect={(index, event) => void selectResult(results, index, onClose, event)}
      onAlternateSelect={(index) => void results[index]?.alternateRun?.()}
      renderResult={renderWorkTreeResult}
      loading={worktrees.isFetching || configs.isFetching}
    />
  )
}

function renderWorkTreeResult(result: UniversalMenuResult, state: UniversalMenuRenderState) {
  const depth = result.depth ?? 0
  if (result.id.startsWith('worktree-clone:')) {
    return (
      <button
        type="button"
        disabled={state.disabled}
        onMouseEnter={state.onMouseEnter}
        onClick={(event) => state.onSelect(event)}
        className={rowClassName(state)}
        style={{ paddingLeft: `${16 + depth * 18}px` }}
      >
        <span className="flex w-3 shrink-0 items-center justify-center text-neutral-500"><Plus className="h-3.5 w-3.5" aria-hidden="true" /></span>
        <span className="min-w-0 flex-1 truncate text-left">{result.label}</span>
        {result.detail && <span className="hidden max-w-[44%] truncate text-[11px] text-neutral-500 sm:block">{result.detail}</span>}
      </button>
    )
  }
  return <UniversalMenuHierarchyRow result={result} state={state} />
}

function workTreeScopeResults({
  worktrees,
  configs,
  loading,
  configsLoading,
  error,
  configsError,
  query,
  workspaceId,
  openNewWorkspaceChat,
  startChat,
}: {
  worktrees?: RepoWorktreeRow[]
  configs?: RepoConfigRow[]
  loading: boolean
  configsLoading: boolean
  error: unknown
  configsError: unknown
  query: string
  workspaceId?: string
  openNewWorkspaceChat: UniversalScopeProps['openDetails']
  startChat: (path: string) => Promise<void>
}): UniversalMenuResult[] {
  if (loading || configsLoading) return [disabledRow('worktrees-loading', 'Loading work trees...')]
  if (error) return [disabledRow('worktrees-error', extractTrpcMessage(error))]
  if (configsError) return [disabledRow('worktrees-config-error', extractTrpcMessage(configsError))]
  const q = query.trim().toLowerCase()
  const flat = (worktrees ?? []).filter((worktree) => !q || `${worktree.name} ${worktree.slug} ${worktree.worktreeName} ${worktree.worktreeSlug} ${worktree.githubFullName ?? ''} ${worktree.workingDir}`.toLowerCase().includes(q))
  const matchingConfigs = (configs ?? []).filter((config) => !q || `${config.name} ${config.githubFullName ?? ''} ${config.originUrl ?? ''}`.toLowerCase().includes(q))
  const worktreesByLabel = new Map<string, RepoWorktreeRow[]>()
  for (const worktree of flat) {
    const label = worktree.githubFullName ?? worktree.name
    const repoWorktrees = worktreesByLabel.get(label)
    if (repoWorktrees) repoWorktrees.push(worktree)
    else worktreesByLabel.set(label, [worktree])
  }
  const configByLabel = new Map<string, RepoConfigRow>()
  for (const config of configs ?? []) {
    const label = config.githubFullName ?? config.name
    configByLabel.set(label, config)
  }
  const rows: UniversalMenuResult[] = []
  if (matchingConfigs.length > 0) {
    rows.push(groupRow('worktree-clone-section', 'Clone repo', 0))
    for (const config of matchingConfigs) {
      const label = config.githubFullName ?? config.name
      rows.push({
        id: `worktree-clone:${config.id}`,
        kind: 'worktree',
        label,
        detail: config.originUrl ?? undefined,
        parentId: 'worktree-clone-section',
        depth: 1,
        haystack: `${config.name} ${config.githubFullName ?? ''} ${config.originUrl ?? ''}`,
        run: () => openNewWorkspaceChat({ type: 'repoConfig', configId: config.id, worktreeName: '' }),
      })
    }
  }
  for (const [repoLabel, repoWorktrees] of worktreesByLabel) {
    const config = configByLabel.get(repoLabel)
    const groupId = `worktree-repo:${repoLabel}`
    rows.push(groupRow(groupId, repoLabel, 0, config?.originUrl ?? undefined))
    for (const worktree of repoWorktrees) {
      rows.push({
        id: `worktree:${worktree.id}`,
        kind: 'worktree',
        label: worktree.worktreeName,
        detail: displayPath(worktree.workingDir, undefined),
        parentId: groupId,
        depth: 1,
        flatHierarchy: true,
        icon: paneTabIconForType('file'),
        haystack: `${repoLabel} ${worktree.worktreeName} ${worktree.workingDir}`,
        disabled: !workspaceId,
        run: () => startChat(worktree.workingDir),
        alternateRun: () => openNewWorkspaceChat({ type: 'worktree', repoId: worktree.id, path: worktree.workingDir, name: worktree.worktreeName }),
      })
    }
  }
  return rows.length ? rows : [disabledRow('worktrees-empty', q ? 'No matching work trees or repo configs.' : 'No repo configs or work trees yet.')]
}
