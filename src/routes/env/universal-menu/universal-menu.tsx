import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { OverlayShell } from '../../../components/overlay-shell'
import { Button, Field, Input } from '../../../components/ui'
import { paneTabIconForType } from '../../../components/tab-icon'
import { envTrpc } from '../../../env-trpc'
import { trpc } from '../../../trpc'
import { browserTabIconForUrl, faviconOriginForUrl, type FaviconCacheRecord } from '../../../lib/favicon-cache'
import { extractTrpcMessage } from '../../../lib/utils'
import type { PaneContent } from '../shell/tab-state'
import { defaultWorkspaceName, newAgentChatStartInput, resolveWorkspaceName, type NewAgentChatSelection } from '../agent/new-agent-chat-state'
import { WorkspaceModeControl } from '../agent/new-agent-chat-modal'
import { fileSystemScopeModule } from './scopes/file-system'
import { findFilesScopeModule } from './scopes/find-files'
import { recentFoldersScopeModule } from './scopes/recent-folders'
import { shellsScopeModule } from './scopes/shells'
import { webScopeModule } from './scopes/web'
import { worktreesScopeModule } from './scopes/worktrees'
import { workspacesScopeModule } from './scopes/workspaces'
import { openFolderScope, scopeByKey, universalMenuCommandResults, universalMenuScopes } from './commands'
import { UniversalMenuLandingPage, type UniversalMenuLandingSection } from './landing-page'
import { CompactPath, UniversalMenuResultList } from './shared'
import { basename, displayPath, webQueryUrl } from './utils'
import type { ScopeDefinition, UniversalMenuContextItem, UniversalMenuResult, UniversalScopeApi } from './types'

export type { UniversalMenuContextItem } from './types'

interface AgentSessionRow {
  id: string
  workingDir: string | null
  title?: string | null
}

interface HomeProbeData {
  home?: string | null
}

interface ShellRow {
  id: string
  cwd: string
  title: string | null
  ownerKind?: string
  alive?: boolean
}

interface RepoConfigRow {
  id: string
  name: string
  originUrl?: string | null
  githubFullName?: string | null
}

const componentScopeById = new Map([
  [fileSystemScopeModule.id, fileSystemScopeModule],
  [findFilesScopeModule.id, findFilesScopeModule],
  [recentFoldersScopeModule.id, recentFoldersScopeModule],
  [shellsScopeModule.id, shellsScopeModule],
  [webScopeModule.id, webScopeModule],
  [worktreesScopeModule.id, worktreesScopeModule],
  [workspacesScopeModule.id, workspacesScopeModule],
])

export function UniversalMenu({
  open,
  workspaceName = 'Current workspace',
  workspaceId,
  workspaceFolderId,
  activeSessionId,
  hasActiveTab,
  contextItems = [],
  onClose,
  onOpenContent,
  onCreatedChat,
  onSwitchWorkspace,
  onCloseTab,
  onToggleAgentPane,
  onToggleSidebar,
  onOpenSettings,
}: {
  open: boolean
  workspaceName?: string
  workspaceId?: string
  workspaceFolderId?: string | null
  activeSessionId?: string | null
  hasActiveTab: boolean
  contextItems?: UniversalMenuContextItem[]
  onClose: () => void
  onOpenContent?: (content: PaneContent) => void
  onCreatedChat?: (sessionId: string, workspaceId?: string) => void
  onSwitchWorkspace?: (workspaceId: string) => void
  onCloseTab: () => void
  onToggleAgentPane?: () => void
  onToggleSidebar?: () => void
  onOpenSettings?: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [mouseMoved, setMouseMoved] = useState(false)
  const [scope, setScope] = useState<{ definition: ScopeDefinition; query: string } | null>(null)
  const [detailsSelection, setDetailsSelection] = useState<NewAgentChatSelection | null>(null)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState({ value: '', edited: false })
  const [parentFolderId, setParentFolderId] = useState<string | null>(null)
  const [scopeApi, setScopeApi] = useState<UniversalScopeApi | null>(null)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const scopeApiRef = useRef<UniversalScopeApi | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const updateScopeApi = useCallback((api: UniversalScopeApi | null) => {
    scopeApiRef.current = api
    setScopeApi((current) => {
      if (!api || !current) return current === api ? current : api
      const currentHints = current.footerHints ?? []
      const nextHints = api.footerHints ?? []
      if (current.resultCount === api.resultCount && Boolean(current.activeActions?.length) === Boolean(api.activeActions?.length) && currentHints.length === nextHints.length && currentHints.every((hint, index) => hint === nextHints[index])) return current
      return api
    })
  }, [])
  const folderProbe = envTrpc.fs.browseHome.useQuery(
    { path: undefined },
    { enabled: open, refetchOnWindowFocus: false, staleTime: 30_000 },
  )
  const sessions = envTrpc.agent.sessionList.useQuery(workspaceId ? { workspaceId } : undefined, {
    enabled: open && !!workspaceId,
    staleTime: 5_000,
  })
  const workspaceShells = envTrpc.shell.list.useQuery(workspaceId ? { workspaceId } : undefined, {
    enabled: open && !scope && !!workspaceId,
    staleTime: 5_000,
  })
  const repoConfigs = envTrpc.repo.listConfigs.useQuery(undefined, { enabled: open && !!detailsSelection, staleTime: 5_000 })
  const workspaceTree = trpc.workspace.listTree.useQuery(undefined, { enabled: open && !!detailsSelection, staleTime: 15_000 })
  const envUtils = envTrpc.useUtils()
  const startChat = envTrpc.agent.sessionStart.useMutation()
  const createShell = envTrpc.shell.create.useMutation()
  const disposeShell = envTrpc.shell.dispose.useMutation()
  const cloneConfig = envTrpc.repo.cloneConfig.useMutation()
  const createWorkspace = trpc.workspace.create.useMutation()
  const upsertWorkspaceResource = trpc.workspace.upsertResource.useMutation()
  const faviconOrigins = useMemo(() => Array.from(new Set(
    contextItems
      .filter((item) => item.kind === 'browser-tab' && item.content.type === 'browser')
      .map((item) => item.content.type === 'browser' ? faviconOriginForUrl(item.content.url) : null)
      .filter((origin): origin is string => Boolean(origin)),
  )), [contextItems])
  const faviconCache = trpc.favicon.getByOrigins.useQuery(
    { origins: faviconOrigins },
    { enabled: open && !scope && faviconOrigins.length > 0, staleTime: 60_000 },
  )
  const activeCwd = activeSessionId
    ? ((sessions.data as AgentSessionRow[] | undefined) ?? []).find((session) => session.id === activeSessionId)?.workingDir ?? undefined
    : undefined
  const homePath = (folderProbe.data as HomeProbeData | undefined)?.home ?? undefined

  const enterScope = useCallback((definition: ScopeDefinition, initialQuery: string) => {
    setScope({ definition, query: initialQuery })
    setQuery(initialQuery)
    setActive(0)
    setMouseMoved(false)
  }, [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    setMouseMoved(false)
    setScope(null)
    setDetailsSelection(null)
    setDetailsError(null)
    setWorkspaceNameDraft({ value: '', edited: false })
    setParentFolderId(null)
    setActionMenuOpen(false)
    updateScopeApi(null)
  }, [open])

  useEffect(() => {
    if (!scope || componentScopeById.has(scope.definition.id)) return
    updateScopeApi(null)
  }, [scope?.definition.id, scope, updateScopeApi])

  useLayoutEffect(() => {
    if (!open) return
    const focusInput = () => {
      window.focus()
      inputRef.current?.focus()
    }
    focusInput()
    const frame = requestAnimationFrame(focusInput)
    const retry = window.setTimeout(focusInput, 50)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(retry)
    }
  }, [open, scope?.definition.id])

  const commandResults = useMemo<UniversalMenuResult[]>(() => {
    return universalMenuCommandResults({
      activeCwd,
      workspaceId,
      hasActiveTab,
      scopes: universalMenuScopes,
      enterScope,
      createShell,
      onCloseTab,
      onOpenContent,
      onOpenSettings,
      onToggleAgentPane,
      onToggleSidebar,
    })
  }, [activeCwd, createShell, enterScope, hasActiveTab, onCloseTab, onOpenContent, onOpenSettings, onToggleAgentPane, onToggleSidebar, workspaceId])

  const visibleResults = useMemo(() => {
    if (scope) return []
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return []
    const directUrl = webQueryUrl(query)
    const rows: UniversalMenuResult[] = []
    if (directUrl) {
      rows.push({
        id: `web-url:${directUrl}`,
        kind: 'browser-tab',
        label: directUrl,
        detail: 'open URL',
        icon: browserTabIconForUrl({ url: directUrl, records: (faviconCache.data ?? {}) as Record<string, FaviconCacheRecord> }),
        haystack: directUrl,
        disabled: !onOpenContent,
        run: () => onOpenContent?.({ type: 'browser', url: directUrl }),
      })
    }
    rows.push(...commandResults
      .map((result) => ({ result, score: fuzzyScore(result.haystack.toLowerCase(), trimmed) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.result))
    return rows
  }, [commandResults, faviconCache.data, onOpenContent, query, scope])

  const contextualSections = useMemo<UniversalMenuLandingSection[]>(() => {
    const folderMap = new Map<string, UniversalMenuResult>()
    for (const session of (sessions.data as AgentSessionRow[] | undefined) ?? []) {
      if (!session.workingDir) continue
      const label = basename(session.workingDir)
      if (!folderMap.has(session.workingDir)) {
        folderMap.set(session.workingDir, {
        id: `folder:${session.workingDir}`,
        kind: 'folder',
          label,
          detail: displayPath(session.workingDir, homePath),
          detailNode: <CompactPath path={displayPath(session.workingDir, homePath)} />,
        icon: paneTabIconForType('file'),
        badge: 'chat',
        haystack: `${label} ${session.workingDir}`,
        disabled: !workspaceId || startChat.isPending,
          run: async () => {
            if (!workspaceId || !session.workingDir) return
            const created = await startChat.mutateAsync({ workspaceId, directory: session.workingDir }) as { id: string }
            onCreatedChat?.(created.id, workspaceId)
          },
          alternateRun: () => openDetails({ type: 'folder', path: session.workingDir! }),
      })
      }
    }

    const shellMap = new Map<string, UniversalMenuResult>()
    const deleteShell = async (shellId: string) => {
      await disposeShell.mutateAsync({ id: shellId })
      await envUtils.shell.list.invalidate(workspaceId ? { workspaceId } : undefined)
    }
    for (const shell of (workspaceShells.data as ShellRow[] | undefined) ?? []) {
      if (shell.alive === false) continue
      shellMap.set(shell.id, {
        id: `shell:${shell.id}`,
        kind: 'shell',
        label: shell.title || `shell ${shell.id.slice(-6)}`,
        detail: displayPath(shell.cwd, homePath),
        detailNode: <CompactPath path={displayPath(shell.cwd, homePath)} />,
        icon: paneTabIconForType('shell'),
        haystack: `${shell.title ?? ''} ${shell.id} ${shell.cwd} ${shell.ownerKind ?? ''}`,
        run: () => onOpenContent?.({ type: 'shell', shellId: shell.id }),
        actions: [{ id: 'terminate', label: 'Terminate shell', key: 't', run: () => deleteShell(shell.id) }],
      })
    }
    for (const item of contextItems.filter((item) => item.kind === 'shell')) {
      const shellId = item.content.type === 'shell' ? item.content.shellId : item.id
      if (workspaceId && workspaceShells.data && !(workspaceShells.data as ShellRow[]).some((shell) => shell.id === shellId && shell.alive !== false)) continue
      if (shellMap.has(shellId)) continue
      shellMap.set(item.id, {
        id: item.id,
        kind: 'shell',
        label: item.label,
        detail: item.detail ? displayPath(item.detail, homePath) : undefined,
        detailNode: item.detail ? <CompactPath path={displayPath(item.detail, homePath)} /> : undefined,
        icon: paneTabIconForType('shell'),
        haystack: `${item.label} ${item.detail ?? ''}`,
        run: () => onOpenContent?.(item.content),
        actions: [{ id: 'terminate', label: 'Terminate shell', key: 't', run: () => deleteShell(shellId) }],
      })
    }
    const shells = [...shellMap.values()]

    const pages = contextItems
      .filter((item) => item.kind === 'browser-tab')
      .map((item): UniversalMenuResult => ({
        id: item.id,
        kind: 'browser-tab',
        label: item.label,
        detail: item.detail,
        icon: item.content.type === 'browser'
          ? browserTabIconForUrl({ url: item.content.url, records: (faviconCache.data ?? {}) as Record<string, FaviconCacheRecord> })
          : paneTabIconForType('browser'),
        haystack: `${item.label} ${item.detail ?? ''}`,
        run: () => onOpenContent?.(item.content),
      }))

    return [
      { id: 'folders', label: 'Recent workspace folders', results: [...folderMap.values()] },
      { id: 'shells', label: 'Shells', results: shells },
      { id: 'browser-tabs', label: 'Pages', results: pages },
    ].filter((section) => section.results.length > 0)
  }, [contextItems, disposeShell, envUtils.shell.list, faviconCache.data, homePath, onCreatedChat, onOpenContent, sessions.data, startChat, workspaceId, workspaceShells.data])

  const contextualCount = contextualSections.reduce((sum, section) => sum + section.results.length, 0)
  const contextualResults = useMemo(() => contextualSections.flatMap((section) => section.results), [contextualSections])

  useEffect(() => {
    if (!scope && !query.trim()) return
    const length = scopeApi ? scopeApi.resultCount : visibleResults.length
    if (active >= length) setActive(0)
  }, [active, query, scope, scopeApi, visibleResults.length])

  useEffect(() => {
    if (scope || query.trim()) return
    if (active >= contextualResults.length) setActive(0)
  }, [active, contextualResults.length, query, scope])

  const currentScopeComponent = scope ? componentScopeById.get(scope.definition.id) : undefined

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (actionMenuOpen) {
          setActionMenuOpen(false)
          return
        }
        goBackOrClose()
        return
      }
      const activeScopeApi = scopeApiRef.current
      const selectedActions = activeScopeApi?.activeActions ?? (!scope && !query.trim() ? contextualResults[active]?.actions : visibleResults[active]?.actions) ?? []
      if (actionMenuOpen) {
        const action = selectedActions.find((candidate) => candidate.key.toLowerCase() === event.key.toLowerCase())
        if (action) {
          event.preventDefault()
          void runAction(action)
          return
        }
      }
      if (event.key === 'Alt' && selectedActions.length > 0) {
        event.preventDefault()
        setActionMenuOpen(true)
        return
      }
      if (event.key === 'Backspace' && scope && query.length === 0) {
        event.preventDefault()
        exitScope()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const length = activeScopeApi ? activeScopeApi.resultCount : scope || query.trim() ? visibleResults.length : contextualResults.length
        setActionMenuOpen(false)
        setActive((value) => Math.min(Math.max(length - 1, 0), value + 1))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActionMenuOpen(false)
        setActive((value) => Math.max(0, value - 1))
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        if (activeScopeApi) {
          void activeScopeApi.selectActive({ shiftKey: event.shiftKey })
          return
        }
        if (!scope && !query.trim()) void pickContextual(active, { shiftKey: event.shiftKey })
        else void pick(active, { shiftKey: event.shiftKey })
        return
      }
      if (scopeApiRef.current?.handleKeyDown?.(event)) return
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  if (!open) return null

  function setInputValue(value: string) {
    if (!scope) {
      if (isPathLikeInput(value)) {
        startTransition(() => enterScope(openFolderScope, value))
        return
      }
      const first = value[0]
      const keyedScope = first ? scopeByKey.get(first) : undefined
      if (keyedScope) {
        startTransition(() => enterScope(keyedScope, keyedScope.id === 'open-folder' ? value : value.slice(1)))
        return
      }
    }
    setQuery(value)
    if (scope) setScope({ ...scope, query: value })
    setActive(0)
    setMouseMoved(false)
    setActionMenuOpen(false)
  }

  function activateIndex(index: number) {
    setActive(index)
    setActionMenuOpen(false)
  }

  function openActions(index: number) {
    setActive(index)
    setActionMenuOpen(true)
  }

  async function runAction(action: { run: () => void | Promise<void> }) {
    await action.run()
    setActionMenuOpen(false)
  }

  async function pick(index: number, event?: { shiftKey?: boolean }) {
    const result = visibleResults[index]
    if (!result || result.disabled) return
    if (event?.shiftKey && result.alternateRun) {
      await result.alternateRun()
      return
    }
    await result.run()
    if (!result.keepOpen) onClose()
  }

  async function pickContextual(index: number, event?: { shiftKey?: boolean }) {
    const result = contextualResults[index]
    if (!result || result.disabled) return
    if (event?.shiftKey && result.alternateRun) {
      await result.alternateRun()
      return
    }
    await result.run()
    if (!result.keepOpen) onClose()
  }

  async function pickAlternate(index: number) {
    const result = visibleResults[index]
    if (!result?.alternateRun) return
    await result.alternateRun()
  }

  function openDetails(selection: NewAgentChatSelection) {
    setDetailsSelection(selection)
    setDetailsError(null)
    setWorkspaceNameDraft({ value: '', edited: false })
    setParentFolderId(workspaceFolderId ?? null)
    setMouseMoved(false)
    setActionMenuOpen(false)
  }

  async function createDetailsChat() {
    if (!detailsSelection) return
    setDetailsError(null)
    try {
      let workingDir: string
      let worktreeRepoId: string | undefined
      if (detailsSelection.type === 'folder') {
        workingDir = detailsSelection.path
      } else if (detailsSelection.type === 'worktree') {
        workingDir = detailsSelection.path
        worktreeRepoId = detailsSelection.repoId
      } else {
        if (!detailsSelection.worktreeName.trim()) {
          setDetailsError('Name the work tree.')
          return
        }
        const cloned = await cloneConfig.mutateAsync({ configId: detailsSelection.configId, worktreeName: detailsSelection.worktreeName }) as { repoId: string; workingDir: string }
        workingDir = cloned.workingDir
        worktreeRepoId = cloned.repoId
      }
      const resolved = resolveWorkspaceName(detailsSelection, workspaceNameDraft)
      const workspace = await createWorkspace.mutateAsync({
        name: resolved.name,
        folderId: parentFolderId,
        nameSource: resolved.source,
        sourceKind: detailsSelection.type === 'folder' ? 'folder' : detailsSelection.type === 'worktree' ? 'worktree' : 'repo_config',
        sourcePath: detailsSelection.type === 'repoConfig' ? workingDir : detailsSelection.path,
      }) as { id: string }
      if (detailsSelection.type !== 'folder') {
        await upsertWorkspaceResource.mutateAsync({
          workspaceId: workspace.id,
          resource: {
            type: 'worktree',
            resourceKey: worktreeRepoId ? `repo:${worktreeRepoId}` : `path:${workingDir}`,
            shared: true,
            data: { repoId: worktreeRepoId, workingDir, name: detailsSelection.type === 'repoConfig' ? detailsSelection.worktreeName : detailsSelection.name },
          },
        })
      }
      const session = await startChat.mutateAsync(newAgentChatStartInput(workspace.id, workingDir)) as { id: string }
      onCreatedChat?.(session.id, workspace.id)
      onClose()
    } catch (error) {
      setDetailsError(extractTrpcMessage(error))
    }
  }

  function goBackOrClose() {
    if (scope) {
      exitScope()
      return
    }
    onClose()
  }

  function exitScope() {
    setScope(null)
    setQuery('')
    setActive(0)
    setMouseMoved(false)
    setActionMenuOpen(false)
  }

  const placeholder = scope ? `Search ${scope.definition.label.toLowerCase()}…` : 'Search commands'
  const resultCount = scopeApi ? scopeApi.resultCount : scope || query.trim() ? visibleResults.length : contextualCount
  const footerHints = scopeApi?.footerHints ?? []
  const selectedResult = scopeApi ? null : scope || query.trim() ? visibleResults[active] : contextualResults[active]
  const selectedActions = scopeApi?.activeActions ?? selectedResult?.actions ?? []
  const showActionHint = selectedActions.length > 0
  const selectedConfig = detailsSelection?.type === 'repoConfig' ? (repoConfigs.data as RepoConfigRow[] | undefined)?.find((config) => config.id === detailsSelection.configId) : null
  const generatedWorkspaceName = defaultWorkspaceName(detailsSelection).name
  const workspaceNameValue = resolveWorkspaceName(detailsSelection, workspaceNameDraft).name
  const detailsBusy = cloneConfig.isPending || createWorkspace.isPending || upsertWorkspaceResource.isPending || startChat.isPending
  const ActiveScopeComponent = currentScopeComponent?.Component

  if (detailsSelection) {
    return (
      <OverlayShell
        onClose={onClose}
        panelClassName="relative !max-w-[700px] !border-neutral-800 pb-7"
        footerClassName="absolute inset-x-0 bottom-0 border-t border-white/5 bg-neutral-950/55 backdrop-blur-xl shadow-[0_-1px_6px_rgba(0,0,0,0.12)]"
        footer={<><span>esc close</span><span className="ml-auto">new workspace</span></>}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-2">
          <button onClick={() => setDetailsSelection(null)} className="rounded px-2 py-1 text-sm leading-none text-neutral-400 hover:bg-highlight hover:text-neutral-100" aria-label="Back">‹</button>
          <div className="text-sm font-medium text-neutral-200">Create chat</div>
        </div>
        <div className="max-h-[54vh] overflow-y-auto pb-2">
          <div className="px-4 pb-2 pt-3">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-neutral-500">Destination</div>
            <div className="rounded border border-neutral-800 bg-neutral-975 px-3 py-2">
              <UniversalMenuSelectedDestination selection={detailsSelection} config={selectedConfig} />
            </div>
          </div>
          {detailsSelection.type === 'repoConfig' && (
            <Field label="Work tree name" className="block px-4 pb-2 pt-3 text-xs text-neutral-400">
              <Input
                value={detailsSelection.worktreeName}
                onChange={(event) => setDetailsSelection({ ...detailsSelection, worktreeName: event.target.value })}
                placeholder="bug-shell-resize"
              />
            </Field>
          )}
          <WorkspaceModeControl
            mode="new"
            onModeChange={() => undefined}
            existingWorkspaceName={workspaceName}
            selectedWorkspaceId={workspaceId}
            workspaceTree={(workspaceTree.data ?? []) as never[]}
            workspaceNameValue={workspaceNameDraft.edited ? workspaceNameDraft.value : generatedWorkspaceName}
            resolvedWorkspaceName={workspaceNameValue}
            parentFolderId={parentFolderId}
            foldersLoading={workspaceTree.isLoading}
            workspacesLoading={workspaceTree.isLoading}
            onParentFolderChange={setParentFolderId}
            onWorkspaceNameChange={(value) => setWorkspaceNameDraft({ value, edited: true })}
          />
          <Button
            variant="secondary"
            onClick={() => void createDetailsChat()}
            disabled={detailsBusy || (detailsSelection.type === 'repoConfig' && !detailsSelection.worktreeName.trim())}
            className="mx-4 mb-4 mt-5"
          >
            {detailsBusy ? 'Creating…' : detailsSelection.type === 'repoConfig' ? 'Clone and create chat' : 'Create chat'}
          </Button>
          {detailsError && <div className="mx-4 mb-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{detailsError}</div>}
        </div>
      </OverlayShell>
    )
  }

  return (
    <OverlayShell
      onClose={onClose}
      panelClassName="relative !max-w-[700px] !border-neutral-800 pb-7"
      footerClassName="absolute inset-x-0 bottom-0 border-t border-white/5 bg-neutral-950/55 backdrop-blur-xl shadow-[0_-1px_6px_rgba(0,0,0,0.12)]"
      footer={(
        <>
          <span>↑↓ navigate</span>
          <span>↵ {scope?.definition.id === 'open-folder' ? 'open/create' : 'open'}</span>
          {footerHints.map((hint) => <span key={hint}>{hint}</span>)}
          {showActionHint && <span>⌥ actions</span>}
          <span>esc {scope ? 'back' : 'close'}</span>
          <span className="ml-auto">{resultCount} result{resultCount === 1 ? '' : 's'}</span>
        </>
      )}
    >
      <div className="bg-neutral-950 px-3 py-3">
        <div className="flex w-full items-center gap-2 rounded-md border border-neutral-800 bg-neutral-975 px-3 py-2 focus-within:border-neutral-600">
          {scope && <span className="shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-400">{scope.definition.label}</span>}
          <input
            ref={inputRef}
            autoFocus
            type="text"
            value={query}
            onChange={(event) => setInputValue(event.target.value)}
            placeholder={placeholder}
            aria-label="Universal menu search"
            className="min-w-0 flex-1 bg-transparent text-sm text-neutral-100 placeholder:text-placeholder focus:outline-none"
          />
        </div>
      </div>
      {!scope && !query.trim() ? (
        <UniversalMenuLandingPage
          scopes={universalMenuScopes}
          sections={contextualSections}
          activeIndex={active}
          mouseMoved={mouseMoved}
          onMouseMoved={() => setMouseMoved(true)}
          onActiveChange={activateIndex}
          actionMenuIndex={actionMenuOpen ? active : null}
          onOpenActions={openActions}
          onRunAction={(action) => void runAction(action)}
          loadingFolders={sessions.isLoading}
          onEnterScope={(definition) => enterScope(definition, '')}
          onSelect={(result, event) => {
            if (result.disabled) return
            if (event?.shiftKey && result.alternateRun) {
              void Promise.resolve(result.alternateRun())
              return
            }
            void Promise.resolve(result.run()).then(onClose)
          }}
        />
      ) : ActiveScopeComponent ? (
        <ActiveScopeComponent
          query={query}
          setQuery={setQuery}
          activeIndex={active}
          mouseMoved={mouseMoved}
          workspaceId={workspaceId}
          workspaceFolderId={workspaceFolderId}
          activeSessionId={activeSessionId}
          contextItems={contextItems}
          onActiveChange={activateIndex}
          onMouseMoved={() => setMouseMoved(true)}
          actionMenuIndex={actionMenuOpen ? active : null}
          onOpenActions={openActions}
          onRunAction={(action) => void runAction(action)}
          onClose={onClose}
          onOpenContent={onOpenContent}
          onCreatedChat={onCreatedChat}
          onSwitchWorkspace={onSwitchWorkspace}
          openDetails={openDetails}
          setScopeApi={updateScopeApi}
        />
      ) : (
        <UniversalMenuResultList
          results={visibleResults}
          activeIndex={active}
          mouseMoved={mouseMoved}
          onMouseMoved={() => setMouseMoved(true)}
          onActiveChange={activateIndex}
          onSelect={(index, event) => void pick(index, event)}
          onAlternateSelect={(index) => void pickAlternate(index)}
          actionMenuIndex={actionMenuOpen ? active : null}
          onOpenActions={openActions}
          onRunAction={(action) => void runAction(action)}
          loading={false}
        />
      )}
    </OverlayShell>
  )
}

function UniversalMenuSelectedDestination({ selection, config }: { selection: NewAgentChatSelection; config?: RepoConfigRow | null }) {
  if (selection.type === 'folder') return <DestinationText title={basename(selection.path)} detail={selection.path} />
  if (selection.type === 'worktree') return <DestinationText title={selection.name ?? basename(selection.path)} detail={selection.path} />
  return <DestinationText title={config?.name ?? 'Repo config'} detail={config?.githubFullName ?? config?.originUrl ?? selection.configId} />
}

function DestinationText({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="min-w-0 text-xs">
      <div className="truncate font-medium text-neutral-200">{title}</div>
      <div className="truncate font-mono text-[10px] text-neutral-500" title={detail}>{detail}</div>
    </div>
  )
}

function isPathLikeInput(value: string): boolean {
  const trimmed = value.trimStart()
  return trimmed.startsWith('~') || trimmed.includes('/')
}

function fuzzyScore(haystack: string, query: string): number {
  if (!query) return 0
  let hi = 0
  let qi = 0
  let score = 0
  let streak = 0
  while (hi < haystack.length && qi < query.length) {
    if (haystack[hi] === query[qi]) {
      streak += 1
      score += 1 + streak * 2
      if (hi === 0 || haystack[hi - 1] === ' ' || haystack[hi - 1] === '/' || haystack[hi - 1] === '.') score += 4
      qi += 1
    } else {
      streak = 0
    }
    hi += 1
  }
  if (qi < query.length) return 0
  return score - haystack.length * 0.005
}
