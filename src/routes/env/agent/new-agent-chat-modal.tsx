import { Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { trpc } from '../../../trpc'
import { envTrpc } from '../../../env-trpc'
import { Button, Field, Input, SegmentedControl } from '../../../components/ui'
import { OverlayShell } from '../../../components/overlay-shell'
import { openNewAgentChatOverlayDetailed } from '../../../lib/overlay-layer-controller'
import { trpcQueryKey } from '../../../lib/trpc-plain'
import { extractTrpcMessage } from '../../../lib/utils'
import { useEnv } from '../env-context'
import { WorkspaceTreePicker, type WorkspaceTreePickerNode } from '../../workspace/workspace-tree-picker'
import {
  defaultWorkspaceName,
  newAgentChatStartInput,
  resolveWorkspaceName,
  validateNewAgentChatSelection,
  type NewAgentChatWorkspaceMode,
  type NewAgentChatSelection,
} from './new-agent-chat-state'

type RecentFolder = { path: string; label: string | null; lastOpenedAt: Date | string }
type RepoConfig = { id: string; name: string; originUrl?: string | null; githubFullName?: string | null }
type RepoWorktree = {
  id: string
  name: string
  slug: string
  worktreeName: string
  worktreeSlug: string
  workingDir: string
  githubFullName?: string | null
}
type WorktreeGroup = { parent: string; worktrees: RepoWorktree[] }
type BrowsePlan = { dir: string | undefined; filter: string }
type ChooserRow =
  | { key: string; kind: 'folder'; selection: NewAgentChatSelection; title: string; detail: string; drillPath?: string }
  | { key: string; kind: 'worktree'; selection: NewAgentChatSelection; title: string; detail: string }
  | { key: string; kind: 'repoConfig'; selection: NewAgentChatSelection; title: string; detail: string }

export function NewAgentChatOverlayLauncher({
  open,
  workspaceId,
  workspaceName = 'Current workspace',
  initialWorkspaceMode = 'existing',
  initialSelection,
  folderId,
  onClose,
  onCreated,
}: {
  open: boolean
  workspaceId?: string
  workspaceName?: string
  initialWorkspaceMode?: NewAgentChatWorkspaceMode
  initialSelection?: NewAgentChatSelection
  folderId?: string | null
  onClose: () => void
  onCreated: (sessionId: string, workspaceId?: string) => void
}) {
  const envContext = useEnv()
  const launchedRef = useRef(false)

  useEffect(() => {
    if (!open) {
      launchedRef.current = false
      return
    }
    if (launchedRef.current) return
    launchedRef.current = true
    void openNewAgentChatOverlayDetailed({
      workspaceId,
      workspaceName,
      initialWorkspaceMode,
      initialSelection,
      folderId,
      env: envContext.env,
      envToken: envContext.envToken,
    }).then((result) => {
      if (result) onCreated(result.sessionId, result.workspaceId)
      onClose()
    }).catch((error) => {
      console.warn('new agent chat overlay failed', error)
      onClose()
    })
  }, [envContext.env, envContext.envToken, folderId, initialSelection, initialWorkspaceMode, onClose, onCreated, open, workspaceId, workspaceName])

  return null
}

export function NewAgentChatOverlay({
  ...props
}: {
  workspaceId?: string
  workspaceName?: string
  initialWorkspaceMode?: NewAgentChatWorkspaceMode
  initialSelection?: NewAgentChatSelection
  folderId?: string | null
  onClose: () => void
  onCreated: (sessionId: string, workspaceId?: string) => void
}) {
  return (
    <Suspense fallback={<NewAgentChatOverlayFallback />}>
      <NewAgentChatOverlayContent {...props} />
    </Suspense>
  )
}

function NewAgentChatOverlayContent({
  workspaceId,
  workspaceName = 'Current workspace',
  initialWorkspaceMode = 'existing',
  initialSelection,
  folderId,
  onClose,
  onCreated,
}: {
  workspaceId?: string
  workspaceName?: string
  initialWorkspaceMode?: NewAgentChatWorkspaceMode
  initialSelection?: NewAgentChatSelection
  folderId?: string | null
  onClose: () => void
  onCreated: (sessionId: string, workspaceId?: string) => void
}) {
  const [recentFolders] = envTrpc.repo.listRecentFolders.useSuspenseQuery(undefined)
  const [repoConfigs] = envTrpc.repo.listConfigs.useSuspenseQuery(undefined)
  const [worktrees] = envTrpc.repo.listWorktrees.useSuspenseQuery(undefined)
  const [workspaceTree] = trpc.workspace.listTree.useSuspenseQuery(undefined)
  const cloneConfig = envTrpc.repo.cloneConfig.useMutation()
  const start = envTrpc.agent.sessionStart.useMutation()
  const createWorkspace = trpc.workspace.create.useMutation()
  const upsertWorkspaceResource = trpc.workspace.upsertResource.useMutation()
  const queryClient = useQueryClient()
  const [selection, setSelection] = useState<NewAgentChatSelection | null>(initialSelection ?? null)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<'choose' | 'details'>(initialSelection ? 'details' : 'choose')
  const [search, setSearch] = useState('')
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const [workspaceMode, setWorkspaceMode] = useState<NewAgentChatWorkspaceMode>(initialWorkspaceMode)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | undefined>(workspaceId)
  const [parentFolderId, setParentFolderId] = useState<string | null>(folderId ?? null)
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState({ value: '', edited: false })
  const searchRef = useRef<HTMLInputElement | null>(null)

  const busy = start.isPending || cloneConfig.isPending || createWorkspace.isPending || upsertWorkspaceResource.isPending
  const validation = validateNewAgentChatSelection(selection)
  const pathMode = isPathSearch(search)
  const pathNeedsHome = pathMode && !search.trimStart().startsWith('/')
  const homeProbe = envTrpc.fs.browseHome.useQuery(
    { path: undefined },
    { enabled: pathMode, refetchOnWindowFocus: false },
  )
  const browsePlan = useMemo(
    () => pathMode && (!pathNeedsHome || homeProbe.data?.home) ? pathBrowsePlan(search, homeProbe.data?.home) : null,
    [homeProbe.data?.home, pathMode, pathNeedsHome, search],
  )
  const pathBrowse = envTrpc.fs.browseHome.useQuery(
    { path: browsePlan?.dir },
    { enabled: pathMode && !!browsePlan, refetchOnWindowFocus: false },
  )

  envTrpc.sync.changes.useSubscription(
    { afterSeq: 0, tables: ['repos', 'recent_folders'] },
    {
      onData(events) {
        const rows = events as Array<{ table?: string }>
        if (rows.some((event) => event.table === 'repos')) {
          void queryClient.invalidateQueries({ queryKey: trpcQueryKey('repo.listWorktrees') })
          void queryClient.invalidateQueries({ queryKey: trpcQueryKey('repo.list') })
        }
        if (rows.some((event) => event.table === 'recent_folders')) {
          void queryClient.invalidateQueries({ queryKey: trpcQueryKey('repo.listRecentFolders') })
        }
      },
    },
  )

  async function createChat() {
    const invalid = validateNewAgentChatSelection(selection)
    if (invalid || !selection) {
      setError(invalid)
      return
    }
    setError(null)
    try {
      let workingDir: string
      let worktreeRepoId: string | undefined
      if (selection.type === 'folder') {
        workingDir = selection.path
      } else if (selection.type === 'worktree') {
        workingDir = selection.path
        worktreeRepoId = selection.repoId
      } else {
        const cloned = await cloneConfig.mutateAsync({
          configId: selection.configId,
          worktreeName: selection.worktreeName,
        })
        workingDir = cloned.workingDir
        worktreeRepoId = cloned.repoId
      }
      let targetWorkspaceId = workspaceMode === 'existing' ? selectedWorkspaceId : undefined
      if (workspaceMode === 'new' || !targetWorkspaceId) {
        const resolved = resolveWorkspaceName(selection, workspaceNameDraft)
        const workspace = await createWorkspace.mutateAsync({
          name: resolved.name,
          folderId: parentFolderId,
          nameSource: resolved.source,
          sourceKind: selection.type === 'folder' ? 'folder' : selection.type === 'worktree' ? 'worktree' : 'repo_config',
          sourcePath: workingDir,
        })
        targetWorkspaceId = workspace.id
      }
      const matchingWorktree = existingWorktrees.find((worktree) => isPathWithinWorktree(workingDir, worktree.workingDir))
      if (targetWorkspaceId && (selection.type === 'worktree' || selection.type === 'repoConfig' || matchingWorktree)) {
        const resourceRepoId = worktreeRepoId ?? matchingWorktree?.id
        const resourceName = selection.type === 'worktree'
          ? selection.name
          : selection.type === 'repoConfig'
            ? selection.worktreeName
            : matchingWorktree?.worktreeName
        await upsertWorkspaceResource.mutateAsync({
          workspaceId: targetWorkspaceId,
          resource: {
            type: 'worktree',
            resourceKey: resourceRepoId ? `repo:${resourceRepoId}` : `path:${matchingWorktree?.workingDir ?? workingDir}`,
            shared: true,
            data: {
              repoId: resourceRepoId,
              workingDir: matchingWorktree?.workingDir ?? workingDir,
              name: resourceName,
            },
          },
        })
      }
      const session = (await start.mutateAsync(newAgentChatStartInput(targetWorkspaceId, workingDir))) as { id: string }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList', { workspaceId: targetWorkspaceId }) }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.list') }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.listTree') }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('repo.listRecentFolders') }),
        queryClient.invalidateQueries({ queryKey: trpcQueryKey('repo.listWorktrees') }),
      ])
      onCreated(session.id, targetWorkspaceId)
      onClose()
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  const folders = recentFolders as RecentFolder[]
  const configs = repoConfigs as RepoConfig[]
  const existingWorktrees = worktrees as RepoWorktree[]
  const treeNodes = workspaceTree as WorkspaceTreePickerNode[]
  const searchableFolders = useMemo(
    () => folders.filter((folder) => !existingWorktrees.some((worktree) => isPathWithinWorktree(folder.path, worktree.workingDir))),
    [existingWorktrees, folders],
  )
  const filteredFolders = useMemo(() => filterRecentFolders(searchableFolders, search), [search, searchableFolders])
  const visibleFolders = useMemo(
    () => search.trim() ? filteredFolders : filteredFolders.slice(0, 10),
    [filteredFolders, search],
  )
  const filteredWorktrees = useMemo(() => filterWorktrees(existingWorktrees, search), [existingWorktrees, search])
  const worktreeGroups = useMemo(() => groupWorktreesByParent(filteredWorktrees), [filteredWorktrees])
  const filteredConfigs = useMemo(() => filterConfigs(configs, search), [configs, search])
  const pathDirs = useMemo(() => {
    const dirs = pathBrowse.data?.dirs ?? []
    const filter = browsePlan?.filter.trim().toLowerCase() ?? ''
    if (!filter) return dirs
    return dirs.filter((dir) => dir.name.toLowerCase().includes(filter))
  }, [browsePlan?.filter, pathBrowse.data?.dirs])
  const selectedConfig = selection?.type === 'repoConfig' ? configs.find((config) => config.id === selection.configId) : null
  const hasChooserResults = pathMode || filteredFolders.length > 0 || filteredWorktrees.length > 0 || filteredConfigs.length > 0
  const chooserRows = useMemo(() => {
    if (pathMode) {
      const rows: ChooserRow[] = []
      if (pathBrowse.data) {
        rows.push({
          key: `folder:${pathBrowse.data.path}`,
          kind: 'folder',
          selection: { type: 'folder', path: pathBrowse.data.path },
          title: 'Use this folder',
          detail: pathBrowse.data.path,
        })
      }
      for (const dir of pathDirs) {
        rows.push({
          key: `folder:${dir.path}`,
          kind: 'folder',
          selection: { type: 'folder', path: dir.path },
          title: dir.name,
          detail: dir.path,
          drillPath: dir.path,
        })
      }
      return rows
    }
    return [
      ...filteredConfigs.map((config): ChooserRow => ({
        key: `repoConfig:${config.id}`,
        kind: 'repoConfig',
        selection: { type: 'repoConfig', configId: config.id, worktreeName: '' },
        title: config.name,
        detail: config.githubFullName ?? config.originUrl ?? config.id,
      })),
      ...filteredWorktrees.map((worktree): ChooserRow => ({
        key: `worktree:${worktree.id}`,
        kind: 'worktree',
        selection: { type: 'worktree', repoId: worktree.id, path: worktree.workingDir, name: worktree.worktreeName },
        title: worktree.worktreeName,
        detail: worktree.workingDir,
      })),
      ...visibleFolders.map((folder): ChooserRow => ({
        key: `folder:${folder.path}`,
        kind: 'folder',
        selection: { type: 'folder', path: folder.path },
        title: folder.label ?? folderName(folder.path),
        detail: folder.path,
      })),
    ]
  }, [filteredConfigs, filteredWorktrees, pathDirs, pathBrowse.data, pathMode, visibleFolders])
  const clonePreview = selectedConfig && selection?.type === 'repoConfig'
    ? `repos/${slugify(selectedConfig.name)}/${slugify(selection.worktreeName || 'work-tree')}`
    : null
  const generatedWorkspaceName = defaultWorkspaceName(selection).name
  const workspaceNameValue = resolveWorkspaceName(selection, workspaceNameDraft).name

  useEffect(() => {
    if (step !== 'choose') return
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [step])

  useEffect(() => {
    setHighlightedIndex(0)
  }, [chooserRows.length, pathMode, search])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  function choose(next: NewAgentChatSelection) {
    setSelection(next)
    setError(null)
    setStep('details')
  }

  function drillIntoPath(path: string) {
    setSearch(`${path.replace(/\/+$/, '')}/`)
    requestAnimationFrame(() => searchRef.current?.focus())
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setHighlightedIndex((index) => Math.min(Math.max(chooserRows.length - 1, 0), index + 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlightedIndex((index) => Math.max(0, index - 1))
      return
    }
    if (event.key === 'Enter') {
      const row = chooserRows[highlightedIndex]
      if (!row) return
      event.preventDefault()
      choose(row.selection)
      return
    }
    if (event.key === 'ArrowRight') {
      const input = event.currentTarget
      const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length
      const row = chooserRows[highlightedIndex]
      if (!pathMode || !atEnd || !row || !('drillPath' in row) || !row.drillPath) return
      event.preventDefault()
      drillIntoPath(row.drillPath)
    }
  }

  return (
    <OverlayShell
      onClose={onClose}
      panelClassName="flex max-h-[min(78vh,1000px)] flex-col"
      footer={step === 'choose'
        ? (
          <>
            <span>↑↓ navigate</span>
            <span>↵ select</span>
            <span>→ open folder</span>
            <span>esc close</span>
          </>
        )
        : undefined}
    >
        {step === 'choose' ? (
          <>
            <div className="shrink-0 border-b border-neutral-800 bg-neutral-950">
              <input
                ref={searchRef}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Search folders, work trees, repo configs, or type a path…"
                className="w-full bg-neutral-950 px-4 py-3 text-sm text-content-strong outline-none placeholder:text-placeholder"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-2 pt-2">
              {pathMode ? (
                <section>
                  <SectionLabel label={pathBrowse.data?.path ?? 'Folders'} meta="path" />
                  {pathBrowse.isLoading && <EmptyList>Loading folders…</EmptyList>}
                  {pathBrowse.error && <EmptyList>{extractTrpcMessage(pathBrowse.error)}</EmptyList>}
                  {pathBrowse.data && (
                    <button onClick={() => choose({ type: 'folder', path: pathBrowse.data.path })} className={compactChoiceClass(highlightedIndex === 0)}>
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="shrink-0 truncate text-content-strong">Use this folder</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-help" title={pathBrowse.data.path}>{pathBrowse.data.path}</span>
                      </span>
                    </button>
                  )}
                  {pathBrowse.data?.parent && (
                    <button onClick={() => setSearch(pathBrowse.data?.parent ?? '')} className={compactChoiceClass(false)}>
                      <span className="min-w-0 flex-1 text-content-default">..</span>
                    </button>
                  )}
                  {pathDirs.map((dir, index) => {
                    const rowIndex = (pathBrowse.data ? 1 : 0) + index
                    const active = highlightedIndex === rowIndex
                    return (
                      <div key={dir.path} className={compactChoiceClass(active)}>
                        <button onClick={() => choose({ type: 'folder', path: dir.path })} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
                          <span className="shrink-0 truncate text-content-strong">{dir.name}</span>
                          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-help" title={dir.path}>{dir.path}</span>
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            drillIntoPath(dir.path)
                          }}
                          className="ml-2 shrink-0 rounded px-1 text-ui-muted hover:bg-neutral-800 hover:text-header-3"
                          aria-label={`Open ${dir.name}`}
                          title="Open folder"
                        >
                          &gt;
                        </button>
                      </div>
                    )
                  })}
                  {pathBrowse.data && pathDirs.length === 0 && !pathBrowse.isLoading && <EmptyList>No folders match this path.</EmptyList>}
                </section>
              ) : (
                <div className="space-y-2">
                  {filteredConfigs.length > 0 && (
                    <ResultSection label="Clone from repo config">
                      {filteredConfigs.map((config, index) => (
                        <button key={config.id} onClick={() => choose({ type: 'repoConfig', configId: config.id, worktreeName: '' })} className={compactChoiceClass(highlightedIndex === index)}>
                          <span className="flex min-w-0 flex-1 items-baseline gap-2">
                            <span className="shrink-0 truncate text-content-strong">{config.name}</span>
                            <span className="min-w-0 flex-1 truncate text-[10px] text-help" title={config.githubFullName ?? config.originUrl ?? config.id}>{config.githubFullName ?? config.originUrl ?? config.id}</span>
                          </span>
                          <span className="ml-2 text-sm text-ui-muted">+</span>
                        </button>
                      ))}
                    </ResultSection>
                  )}
                  {filteredWorktrees.length > 0 && (
                    <ResultSection label="Work trees">
                      {worktreeGroups.map((group) => (
                        <div key={group.parent}>
                          <SectionLabel label={group.parent} />
                          {group.worktrees.map((worktree) => {
                            const rowIndex = filteredConfigs.length + filteredWorktrees.findIndex((item) => item.id === worktree.id)
                            return (
                            <button key={worktree.id} onClick={() => choose({ type: 'worktree', repoId: worktree.id, path: worktree.workingDir, name: worktree.worktreeName })} className={compactChoiceClass(highlightedIndex === rowIndex, 'row')}>
                              <span className="min-w-0 flex-1 text-left">
                                <span className="block truncate text-content-strong">{worktree.worktreeName}</span>
                                <span className="block truncate font-mono text-[10px] text-help" title={worktree.workingDir}>{worktree.workingDir}</span>
                              </span>
                            </button>
                            )
                          })}
                        </div>
                      ))}
                    </ResultSection>
                  )}
                  {visibleFolders.length > 0 && (
                    <ResultSection label="Recent folders">
                      {visibleFolders.map((folder, index) => (
                        <button key={folder.path} onClick={() => choose({ type: 'folder', path: folder.path })} className={compactChoiceClass(highlightedIndex === filteredConfigs.length + filteredWorktrees.length + index)}>
                          <span className="flex min-w-0 flex-1 items-baseline gap-2">
                            <span className="shrink-0 truncate text-content-strong">{folder.label ?? folderName(folder.path)}</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-help" title={folder.path}>{folder.path}</span>
                          </span>
                        </button>
                      ))}
                    </ResultSection>
                  )}
                  {!hasChooserResults && <EmptyList>No folders, work trees, or repo configs match your search.</EmptyList>}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-2">
              <button onClick={() => setStep('choose')} className="rounded px-2 py-1 text-sm leading-none text-ui-default hover:bg-highlight hover:text-header-3" aria-label="Back">‹</button>
              <div className="text-sm font-medium text-header-2">Create chat</div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="px-4 pb-2 pt-3">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-label">Destination</div>
                <div className="rounded border border-neutral-800 bg-input px-3 py-2">
                  <SelectedDestination selection={selection} config={selectedConfig} />
                </div>
              </div>
              {selection?.type === 'repoConfig' && (
                <div>
                  <label className="block px-4 pb-2 pt-3 text-xs text-ui-default">
                    <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-label">Work tree name</span>
                    <Input
                      value={selection.worktreeName}
                      onChange={(event) => setSelection({ ...selection, worktreeName: event.target.value })}
                      placeholder="bug-shell-resize"
                    />
                  </label>
                  {clonePreview && (
                    <div className="truncate px-4 pb-2 text-[10px] text-help" title={clonePreview}>
                      Will clone to <span className="font-mono text-content-default">{clonePreview}</span>
                    </div>
                  )}
                </div>
              )}
              <WorkspaceModeControl
                mode={workspaceMode}
                onModeChange={setWorkspaceMode}
                existingWorkspaceName={workspaceName}
                selectedWorkspaceId={selectedWorkspaceId}
                workspaceTree={treeNodes}
                workspaceNameValue={workspaceNameDraft.edited ? workspaceNameDraft.value : generatedWorkspaceName}
                resolvedWorkspaceName={workspaceNameValue}
                parentFolderId={parentFolderId}
                foldersLoading={false}
                workspacesLoading={false}
                onWorkspaceChange={setSelectedWorkspaceId}
                onParentFolderChange={setParentFolderId}
                onWorkspaceNameChange={(value) => setWorkspaceNameDraft({ value, edited: true })}
              />
              <Button
                variant="secondary"
                onClick={() => void createChat()}
                disabled={busy || !!validation}
                className="mx-4 mb-4 mt-5"
              >
                {busy ? 'Creating…' : selection?.type === 'repoConfig' ? 'Clone and create chat' : 'Create chat'}
              </Button>
            </div>
          </>
        )}
        {error && <div className="mx-4 shrink-0 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{error}</div>}
    </OverlayShell>
  )
}

export function WorkspaceModeControl({
  mode,
  onModeChange,
  existingWorkspaceName,
  selectedWorkspaceId,
  workspaceTree = [],
  workspaceNameValue,
  resolvedWorkspaceName,
  parentFolderId = null,
  foldersLoading = false,
  workspacesLoading = false,
  onWorkspaceChange,
  onParentFolderChange,
  onWorkspaceNameChange,
}: {
  mode: NewAgentChatWorkspaceMode
  onModeChange: (mode: NewAgentChatWorkspaceMode) => void
  existingWorkspaceName: string
  selectedWorkspaceId?: string
  workspaceTree?: WorkspaceTreePickerNode[]
  workspaceNameValue: string
  resolvedWorkspaceName?: string
  parentFolderId?: string | null
  foldersLoading?: boolean
  workspacesLoading?: boolean
  onWorkspaceChange?: (workspaceId: string) => void
  onParentFolderChange?: (folderId: string | null) => void
  onWorkspaceNameChange: (value: string) => void
}) {
  return (
    <div className="shrink-0 px-4 pb-3 pt-3 text-xs text-help">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-label">Workspace</div>
      <div className="space-y-3">
        <SegmentedControl
          value={mode}
          options={[
            { value: 'existing', label: 'Existing' },
            { value: 'new', label: 'New' },
          ]}
          onChange={onModeChange}
          ariaLabel="Workspace mode"
          className="bg-input [&_[aria-pressed='true']]:bg-neutral-800"
        />
        {mode === 'new' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="New workspace">
              <Input
                aria-label="Workspace name"
                value={workspaceNameValue}
                onChange={(event) => onWorkspaceNameChange(event.target.value)}
                title={resolvedWorkspaceName ?? workspaceNameValue}
              />
            </Field>
            <Field label="Parent folder">
              <WorkspaceTreePicker
                mode="folders"
                tree={workspaceTree}
                selectedId={parentFolderId}
                ariaLabel="Parent folder"
                disabled={foldersLoading}
                searchPlaceholder="Search folders..."
                fallbackLabel="No folder"
                onSelect={onParentFolderChange ?? (() => undefined)}
              />
            </Field>
          </div>
        ) : (
          <Field label="Existing workspace">
            <WorkspaceTreePicker
              mode="workspaces"
              tree={workspaceTree}
              selectedId={selectedWorkspaceId}
              ariaLabel="Existing workspace"
              disabled={workspacesLoading}
              searchPlaceholder="Search workspaces..."
              fallbackLabel={existingWorkspaceName}
              onSelect={(value) => value && onWorkspaceChange?.(value)}
            />
          </Field>
        )}
      </div>
    </div>
  )
}

function NewAgentChatOverlayFallback() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="mb-10 flex max-h-[min(84vh,1000px)] w-full max-w-xl flex-col rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl">
        <div className="shrink-0 border-b border-neutral-800 bg-input px-4 py-3 text-sm text-placeholder">
          Loading workspace options…
        </div>
        <div className="p-4 text-xs text-help">Preparing recent folders, work trees, and repo configs.</div>
      </div>
    </div>
  )
}

function EmptyList({ children }: { children: ReactNode }) {
  return <div className="p-4 text-center text-xs text-help">{children}</div>
}

function ResultSection({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <section>
      <SectionLabel label={label} />
      {children}
    </section>
  )
}

function SectionLabel({ label, meta }: { label: string; meta?: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 px-4 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wide text-label first:pt-2">
      <span className="min-w-0 truncate">{label}</span>
      {meta && <span className="shrink-0 text-ui-muted">{meta}</span>}
    </div>
  )
}

function SelectedDestination({ selection, config }: { selection: NewAgentChatSelection | null; config?: RepoConfig | null }) {
  if (!selection) return <div className="text-xs text-help">No destination selected</div>
  if (selection.type === 'folder') {
    return <DestinationText title={folderName(selection.path)} detail={selection.path} />
  }
  if (selection.type === 'worktree') {
    return <DestinationText title={selection.name ?? folderName(selection.path)} detail={selection.path} />
  }
  return <DestinationText title={config?.name ?? 'Repo config'} detail={config?.githubFullName ?? config?.originUrl ?? selection.configId} />
}

function DestinationText({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="min-w-0 text-xs">
      <div className="truncate font-medium text-content-strong">{title}</div>
      <div className="truncate font-mono text-[10px] text-help" title={detail}>{detail}</div>
    </div>
  )
}

function groupWorktreesByParent(worktrees: RepoWorktree[]): WorktreeGroup[] {
  const groups = new Map<string, RepoWorktree[]>()
  for (const worktree of worktrees) {
    const parent = worktree.name || worktree.githubFullName || 'Other work trees'
    const group = groups.get(parent) ?? []
    group.push(worktree)
    groups.set(parent, group)
  }
  return Array.from(groups, ([parent, items]) => ({ parent, worktrees: items }))
}

function filterRecentFolders(folders: RecentFolder[], search: string): RecentFolder[] {
  const q = search.trim().toLowerCase()
  if (!q) return folders
  return folders.filter((folder) => `${folder.label ?? ''} ${folder.path}`.toLowerCase().includes(q))
}

function filterWorktrees(worktrees: RepoWorktree[], search: string): RepoWorktree[] {
  const q = search.trim().toLowerCase()
  if (!q) return worktrees
  return worktrees.filter((worktree) => `${worktree.name} ${worktree.worktreeName} ${worktree.workingDir} ${worktree.githubFullName ?? ''}`.toLowerCase().includes(q))
}

function filterConfigs(configs: RepoConfig[], search: string): RepoConfig[] {
  const q = search.trim().toLowerCase()
  if (!q) return configs
  return configs.filter((config) => `${config.name} ${config.githubFullName ?? ''} ${config.originUrl ?? ''}`.toLowerCase().includes(q))
}

function isPathSearch(value: string): boolean {
  const trimmed = value.trimStart()
  return trimmed.startsWith('/') || trimmed.startsWith('~') || trimmed.includes('/')
}

function pathBrowsePlan(value: string, home?: string): BrowsePlan {
  const trimmed = value.trim()
  const expanded = trimmed.startsWith('~') && home
    ? `${home}${trimmed.slice(1)}`
    : trimmed.startsWith('/')
      ? trimmed
      : home
        ? `${home}/${trimmed}`
        : trimmed
  if (!expanded || expanded === '~') return { dir: home, filter: '' }
  if (expanded.endsWith('/')) return { dir: expanded, filter: '' }
  const slash = expanded.lastIndexOf('/')
  if (slash <= 0) return { dir: '/', filter: expanded.replace(/^\/+/, '') }
  return { dir: expanded.slice(0, slash), filter: expanded.slice(slash + 1) }
}

function compactChoiceClass(selected: boolean, layout: 'col' | 'row' = 'col'): string {
  return (
    `flex w-full min-w-0 ${layout === 'col' ? 'items-center' : 'items-start'} px-4 py-2 text-left text-xs ` +
    (selected ? 'bg-neutral-900 text-header-1' : 'hover:bg-neutral-920 hover:text-header-1')
  )
}

function folderName(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}

function isPathWithinWorktree(pathname: string, worktreePath: string): boolean {
  const path = pathname.replace(/\/+$/, '')
  const root = worktreePath.replace(/\/+$/, '')
  return path === root || path.startsWith(`${root}/`)
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'work-tree'
}
