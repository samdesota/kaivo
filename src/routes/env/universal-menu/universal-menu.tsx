import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { FilePathLabel } from '../../../components/file-path-label'
import { OverlayShell } from '../../../components/overlay-shell'
import { Button, Field, Input } from '../../../components/ui'
import { paneTabIconForType, TabIconView, type TabIcon } from '../../../components/tab-icon'
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
import type { UniversalScopeApi } from './types'

export type UniversalMenuResultKind =
  | 'action'
  | 'scope'
  | 'folder'
  | 'worktree'
  | 'shell'
  | 'browser-tab'
  | 'bookmark'
  | 'workspace'
  | 'file'

export interface UniversalMenuResult {
  id: string
  kind: UniversalMenuResultKind
  label: string
  labelNode?: ReactNode
  detail?: string
  detailNode?: ReactNode
  actionHint?: string
  badge?: string
  icon?: TabIcon
  parentId?: string
  depth?: number
  flatHierarchy?: boolean
  haystack: string
  disabled?: boolean
  keepOpen?: boolean
  run: () => void | Promise<void>
  alternateRun?: () => void | Promise<void>
  drill?: () => void
}

export interface UniversalMenuContextItem {
  id: string
  kind: 'shell' | 'browser-tab'
  label: string
  detail?: string
  content: PaneContent
}

interface AgentSessionRow {
  id: string
  workingDir: string | null
  title?: string | null
}

interface FolderBrowseDir {
  name: string
  path: string
}

interface FolderBrowseData {
  path: string
  home?: string | null
  defaultPath?: string | null
  parent?: string | null
  dirs: FolderBrowseDir[]
  files?: FolderBrowseDir[]
}

interface FolderBrowsePlan {
  dir: string | undefined
  filter: string
}

interface RecentFolderRow {
  path: string
  label: string | null
  lastOpenedAt?: string | Date
}

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

interface ShellRow {
  id: string
  cwd: string
  title: string | null
  ownerKind?: string
  alive?: boolean
}

type WorkspaceTreeNode =
  | { type: 'folder'; folder: { id: string; name: string }; children: WorkspaceTreeNode[] }
  | { type: 'workspace'; workspace: { id: string; name: string; folderId?: string | null } }

interface GitFileRow {
  root: string
  path: string
  relativePath: string
}

export interface UniversalMenuRenderState {
  active: boolean
  disabled: boolean
  onMouseEnter: () => void
  onSelect: (event?: { shiftKey?: boolean }) => void
  onAlternateSelect: () => void
}

type ScopeId = 'open-folder' | 'recent-folders' | 'work-trees' | 'find-files' | 'web' | 'shells' | 'workspaces'

interface ScopeDefinition {
  id: ScopeId
  label: string
  key: string
  detail: string
  placeholder: string
}

interface ScopeKeyContext {
  activeResult: UniversalMenuResult | undefined
  browsePath: string | undefined
  drillIntoFolder: (path: string) => void
  setActive: (index: number) => void
}

interface ScopeController {
  definition: ScopeDefinition
  footerHints?: string[]
  renderResult?: (result: UniversalMenuResult, state: UniversalMenuRenderState) => ReactNode
  handleKeyDown?: (event: KeyboardEvent, context: ScopeKeyContext) => boolean
}

const fileSystemScopeController: ScopeController = {
  definition: { id: 'open-folder', label: 'File System', key: '/', detail: 'Open files or choose folders for chats', placeholder: 'File system browsing lands in Task 3' },
  footerHints: ['←/→ folder'],
}

const scopeControllers: ScopeController[] = [
  fileSystemScopeController,
  { definition: { id: 'recent-folders', label: 'Recent Folders', key: ':', detail: 'Search folders used by prior chats', placeholder: 'Recent folder search lands in Task 4' } },
  { definition: { id: 'work-trees', label: 'Work Trees', key: '#', detail: 'Search repo worktrees', placeholder: 'Worktree search lands in Task 5' }, renderResult: renderWorkTreeResult },
  { definition: { id: 'find-files', label: 'Find Files', key: '.', detail: 'Search git files in open chat folders', placeholder: 'File search lands in Task 9' } },
  { definition: { id: 'web', label: 'Web', key: '@', detail: 'Search tabs and bookmarks', placeholder: 'Web search lands in Task 7' } },
  { definition: { id: 'shells', label: 'Shells', key: '$', detail: 'Search workspace shells', placeholder: 'Shell search lands in Task 6' } },
  { definition: { id: 'workspaces', label: 'Workspaces', key: '>', detail: 'Switch workspace', placeholder: 'Workspace search lands in Task 8' } },
]

const componentScopeById = new Map([
  [fileSystemScopeModule.id, fileSystemScopeModule],
  [findFilesScopeModule.id, findFilesScopeModule],
  [recentFoldersScopeModule.id, recentFoldersScopeModule],
  [shellsScopeModule.id, shellsScopeModule],
  [webScopeModule.id, webScopeModule],
  [worktreesScopeModule.id, worktreesScopeModule],
  [workspacesScopeModule.id, workspacesScopeModule],
])

const scopes = scopeControllers.map((controller) => controller.definition)
const scopeControllerById = new Map(scopeControllers.map((controller) => [controller.definition.id, controller]))
const openFolderScope = fileSystemScopeController.definition
const scopeByKey = new Map(scopes.map((scope) => [scope.key, scope]))

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
  const scopeApiRef = useRef<UniversalScopeApi | null>(null)
  const previousFindFilesResultsRef = useRef<UniversalMenuResult[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const updateScopeApi = useCallback((api: UniversalScopeApi | null) => {
    scopeApiRef.current = api
    setScopeApi((current) => {
      if (!api || !current) return current === api ? current : api
      const currentHints = current.footerHints ?? []
      const nextHints = api.footerHints ?? []
      if (current.resultCount === api.resultCount && currentHints.length === nextHints.length && currentHints.every((hint, index) => hint === nextHints[index])) return current
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
  const recentFolders = envTrpc.repo.listRecentFolders.useQuery(undefined, { enabled: false, staleTime: 5_000 })
  const repoConfigs = envTrpc.repo.listConfigs.useQuery(undefined, { enabled: open && !!detailsSelection, staleTime: 5_000 })
  const worktrees = envTrpc.repo.listWorktrees.useQuery(undefined, { enabled: false, staleTime: 5_000 })
  const shells = envTrpc.shell.list.useQuery(workspaceId ? { workspaceId } : undefined, { enabled: false, staleTime: 5_000 })
  const workspaceTree = trpc.workspace.listTree.useQuery(undefined, { enabled: open && !!detailsSelection, staleTime: 15_000 })
  const startChat = envTrpc.agent.sessionStart.useMutation()
  const createShell = envTrpc.shell.create.useMutation()
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
  const fileRoots = useMemo(() => Array.from(new Set(((sessions.data as AgentSessionRow[] | undefined) ?? []).map((session) => session.workingDir).filter((dir): dir is string => Boolean(dir)))), [sessions.data])
  const activeCwd = activeSessionId
    ? ((sessions.data as AgentSessionRow[] | undefined) ?? []).find((session) => session.id === activeSessionId)?.workingDir ?? undefined
    : undefined
  const gitFiles = envTrpc.fs.searchGitTrackedFiles.useQuery(
    { roots: fileRoots, query, limit: 160 },
    { enabled: false, staleTime: 10_000 },
  )
  const homePath = (folderProbe.data as FolderBrowseData | undefined)?.home ?? undefined

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
    const out: UniversalMenuResult[] = scopes.map((definition) => ({
      id: `scope:${definition.id}`,
      kind: 'scope',
      label: definition.label,
      badge: definition.key,
      haystack: `${definition.label} ${definition.detail} ${definition.key}`,
      run: () => enterScope(definition, ''),
    }))

    out.push({
      id: 'action:new-shell',
      kind: 'action',
      label: 'New shell',
      haystack: 'new shell terminal command workspace',
      run: async () => {
        const info = await createShell.mutateAsync({ ...(workspaceId ? { workspaceId } : {}), ...(activeCwd ? { cwd: activeCwd } : {}) }) as { id: string }
        onOpenContent?.({ type: 'shell', shellId: info.id })
      },
    })

    if (hasActiveTab) {
      out.push({
        id: 'action:close-tab',
        kind: 'action',
        label: 'Close current tab',
        haystack: 'close current tab pane browser shell file',
        run: onCloseTab,
      })
    }

    out.push(
      {
        id: 'action:toggle-agent-pane',
        kind: 'action',
        label: 'Collapse agent pane',
        haystack: 'collapse expand toggle agent pane chat',
        disabled: !onToggleAgentPane,
        run: () => onToggleAgentPane?.(),
      },
      {
        id: 'action:toggle-sidebar',
        kind: 'action',
        label: 'Collapse sidebar',
        haystack: 'collapse expand toggle sidebar workspace navigation',
        disabled: !onToggleSidebar,
        run: () => onToggleSidebar?.(),
      },
      {
        id: 'action:settings',
        kind: 'action',
        label: 'Settings',
        haystack: 'settings preferences configuration providers credentials',
        disabled: !onOpenSettings,
        run: () => onOpenSettings?.(),
      },
    )
    return out
  }, [activeCwd, createShell, enterScope, hasActiveTab, onCloseTab, onOpenContent, onOpenSettings, onToggleAgentPane, onToggleSidebar, workspaceId])

  const visibleResults = useMemo(() => {
    if (scope && componentScopeById.has(scope.definition.id)) return []
    if (scope?.definition.id === 'recent-folders') {
      return recentFolderScopeResults({
        folders: recentFolders.data as RecentFolderRow[] | undefined,
        loading: recentFolders.isLoading,
        error: recentFolders.error,
        query,
        homePath,
        workspaceFolders: fileRoots,
        workspaceId,
        openNewWorkspaceChat: (path) => openDetails({ type: 'folder', path }),
        startChat: async (path) => {
          if (!workspaceId) return
          const created = await startChat.mutateAsync({ workspaceId, directory: path }) as { id: string }
          onCreatedChat?.(created.id, workspaceId)
        },
      })
    }
    if (scope?.definition.id === 'work-trees') {
      return workTreeScopeResults({
        worktrees: worktrees.data as RepoWorktreeRow[] | undefined,
        configs: repoConfigs.data as RepoConfigRow[] | undefined,
        loading: worktrees.isLoading,
        configsLoading: repoConfigs.isLoading,
        error: worktrees.error,
        configsError: repoConfigs.error,
        query,
        homePath,
        workspaceId,
        openNewWorkspaceChat: openDetails,
        startChat: async (path) => {
          if (!workspaceId) return
          const created = await startChat.mutateAsync({ workspaceId, directory: path }) as { id: string }
          onCreatedChat?.(created.id, workspaceId)
        },
      })
    }
    if (scope?.definition.id === 'shells') {
      return shellScopeResults({ shells: shells.data as ShellRow[] | undefined, loading: shells.isLoading, error: shells.error, query, homePath, openShell: (shellId) => onOpenContent?.({ type: 'shell', shellId }) })
    }
    if (scope?.definition.id === 'web') {
      return webScopeResults({ items: contextItems, query, faviconRecords: (faviconCache.data ?? {}) as Record<string, FaviconCacheRecord>, openContent: (content) => onOpenContent?.(content) })
    }
    if (scope?.definition.id === 'workspaces') {
      return workspaceScopeResults({ tree: workspaceTree.data as WorkspaceTreeNode[] | undefined, loading: workspaceTree.isLoading, error: workspaceTree.error, query, switchWorkspace: (workspaceId) => onSwitchWorkspace?.(workspaceId) })
    }
    if (scope?.definition.id === 'find-files') {
      const next = findFilesScopeResults({ roots: fileRoots, files: gitFiles.data as GitFileRow[] | undefined, loading: gitFiles.isLoading, error: gitFiles.error, query, homePath, openFile: (path) => onOpenContent?.({ type: 'file', path, absolute: true }) })
      if (gitFiles.isLoading && previousFindFilesResultsRef.current.length > 0) return previousFindFilesResultsRef.current
      if (!gitFiles.isLoading && next.length > 0) previousFindFilesResultsRef.current = next
      return next
    }
    if (scope) return placeholderScopeResults(scope.definition)
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return []
    return commandResults
      .map((result) => ({ result, score: fuzzyScore(result.haystack.toLowerCase(), trimmed) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.result)
  }, [commandResults, contextItems, faviconCache.data, fileRoots, gitFiles.data, gitFiles.error, gitFiles.isLoading, homePath, onCreatedChat, onOpenContent, onSwitchWorkspace, query, recentFolders.data, recentFolders.error, recentFolders.isLoading, repoConfigs.data, repoConfigs.error, repoConfigs.isLoading, scope, shells.data, shells.error, shells.isLoading, startChat, workspaceId, workspaceTree.data, workspaceTree.error, workspaceTree.isLoading, worktrees.data, worktrees.error, worktrees.isLoading])

  const contextualSections = useMemo(() => {
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

    const shells = contextItems
      .filter((item) => item.kind === 'shell')
      .map((item): UniversalMenuResult => ({
        id: item.id,
        kind: 'shell',
        label: item.label,
        detail: item.detail ? displayPath(item.detail, homePath) : undefined,
        detailNode: item.detail ? <CompactPath path={displayPath(item.detail, homePath)} /> : undefined,
        icon: paneTabIconForType('shell'),
        haystack: `${item.label} ${item.detail ?? ''}`,
        run: () => onOpenContent?.(item.content),
      }))

    const browserTabs = contextItems
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
      { id: 'browser-tabs', label: 'Pages', results: browserTabs },
    ].filter((section) => section.results.length > 0)
  }, [contextItems, faviconCache.data, homePath, onCreatedChat, onOpenContent, sessions.data, startChat, workspaceId])

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

  const currentScopeController = scope ? scopeControllerById.get(scope.definition.id) : undefined
  const currentScopeComponent = scope ? componentScopeById.get(scope.definition.id) : undefined

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        goBackOrClose()
        return
      }
      if (event.key === 'Backspace' && scope && query.length === 0) {
        event.preventDefault()
        exitScope()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const activeScopeApi = scopeApiRef.current
        const length = activeScopeApi ? activeScopeApi.resultCount : scope || query.trim() ? visibleResults.length : contextualResults.length
        setActive((value) => Math.min(Math.max(length - 1, 0), value + 1))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((value) => Math.max(0, value - 1))
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const activeScopeApi = scopeApiRef.current
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
  }

  const placeholder = scope ? `Search ${scope.definition.label.toLowerCase()}…` : 'Search commands'
  const resultCount = scopeApi ? scopeApi.resultCount : scope || query.trim() ? visibleResults.length : contextualCount
  const footerHints = scopeApi?.footerHints ?? currentScopeController?.footerHints ?? []
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
        {!scope && !query.trim() && <UniversalMenuScopeButtons scopes={scopes} onEnter={(definition) => enterScope(definition, '')} />}
      </div>
      {!scope && !query.trim() ? (
        <UniversalMenuContextView
          sections={contextualSections}
          activeIndex={active}
          mouseMoved={mouseMoved}
          onMouseMoved={() => setMouseMoved(true)}
          onActiveChange={setActive}
          loadingFolders={sessions.isLoading}
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
          onActiveChange={setActive}
          onMouseMoved={() => setMouseMoved(true)}
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
          onActiveChange={setActive}
          onSelect={(index, event) => void pick(index, event)}
          onAlternateSelect={(index) => void pickAlternate(index)}
          renderResult={currentScopeController?.renderResult}
          loading={false}
        />
      )}
    </OverlayShell>
  )
}

function renderWorkTreeResult(result: UniversalMenuResult, state: UniversalMenuRenderState): ReactNode {
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
  if (result.disabled && result.alternateRun) {
    return (
      <div
        className={`${rowClassName(state)} justify-between`}
        style={{ paddingLeft: `${16 + depth * 18}px` }}
      >
        <span className="flex w-3 shrink-0 items-center justify-center text-neutral-600"><ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /></span>
        <span className="min-w-0 flex-1 truncate text-left">{result.label}</span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 text-sm leading-none text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          aria-label={`Create work tree from ${result.label}`}
          title="Create work tree in new workspace"
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            state.onAlternateSelect()
          }}
        >
          +
        </button>
      </div>
    )
  }
  return <UniversalMenuHierarchyRow result={result} state={state} />
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

function UniversalMenuContextView({
  sections,
  activeIndex,
  mouseMoved,
  onMouseMoved,
  onActiveChange,
  loadingFolders,
  onSelect,
}: {
  sections: Array<{ id: string; label: string; results: UniversalMenuResult[] }>
  activeIndex: number
  mouseMoved: boolean
  onMouseMoved: () => void
  onActiveChange: (index: number) => void
  loadingFolders: boolean
  onSelect: (result: UniversalMenuResult, event?: { shiftKey?: boolean }) => void
}) {
  const hasRows = sections.some((section) => section.results.length > 0)
  let rowIndex = 0
  return (
    <div className="max-h-[54vh] overflow-y-auto py-2" data-testid="universal-menu-context-view">
      {sections.map((section) => (
        <section key={section.id} className="py-1">
          <div className="px-4 pb-1 pt-2 text-[11px] uppercase tracking-wide text-neutral-600">{section.label}</div>
          <ul>
            {section.results.map((result) => {
              const index = rowIndex++
              return (
              <li key={result.id} onMouseMove={onMouseMoved}>
                <UniversalMenuResultRow
                  result={result}
                  state={{
                    active: index === activeIndex,
                    disabled: !!result.disabled,
                    onMouseEnter: () => {
                      if (mouseMoved) onActiveChange(index)
                    },
                    onSelect: (event) => onSelect(result, event),
                    onAlternateSelect: () => undefined,
                  }}
                />
              </li>
              )
            })}
          </ul>
        </section>
      ))}
      {!hasRows && <UniversalMenuEmptyRow>{loadingFolders ? 'Loading workspace resources…' : 'No workspace resources are open yet.'}</UniversalMenuEmptyRow>}
    </div>
  )
}

export function UniversalMenuResultList({
  results,
  activeIndex,
  mouseMoved = true,
  onMouseMoved,
  loading = false,
  onActiveChange,
  onSelect,
  onAlternateSelect,
  renderResult,
}: {
  results: UniversalMenuResult[]
  activeIndex: number
  mouseMoved?: boolean
  onMouseMoved?: () => void
  loading?: boolean
  onActiveChange: (index: number) => void
  onSelect: (index: number, event?: { shiftKey?: boolean }) => void
  onAlternateSelect?: (index: number) => void
  renderResult?: (result: UniversalMenuResult, state: UniversalMenuRenderState) => ReactNode
}) {
  if (results.length === 0) return <UniversalMenuEmptyRow>No matches.</UniversalMenuEmptyRow>
  return (
    <ul
      className={`max-h-[54vh] overflow-y-auto py-1 ${loading ? 'animate-[universal-menu-loading-dim_160ms_120ms_forwards]' : ''}`}
      data-testid="universal-menu-results"
    >
      {results.map((result, index) => {
        const state: UniversalMenuRenderState = {
          active: index === activeIndex,
          disabled: !!result.disabled,
          onMouseEnter: () => {
            if (mouseMoved) onActiveChange(index)
          },
          onSelect: (event) => onSelect(index, event),
          onAlternateSelect: () => onAlternateSelect?.(index),
        }
        return (
          <li key={result.id} onMouseMove={onMouseMoved}>
            {renderResult
              ? renderResult(result, state)
              : result.depth !== undefined
                ? <UniversalMenuHierarchyRow result={result} state={state} />
                : <UniversalMenuResultRow result={result} state={state} />}
          </li>
        )
      })}
    </ul>
  )
}

export function UniversalMenuResultRow({ result, state }: { result: UniversalMenuResult; state: UniversalMenuRenderState }) {
  const detail = result.actionHint ? (state.active ? result.actionHint : undefined) : result.detail
  const detailNode = result.actionHint ? undefined : result.detailNode
  return (
    <button
      type="button"
      disabled={state.disabled}
      onMouseEnter={state.onMouseEnter}
      onClick={(event) => state.onSelect(event)}
      className={rowClassName(state)}
    >
      {result.icon && <TabIconView icon={result.icon} />}
      <span className={`min-w-0 flex-1 text-left ${result.labelNode ? '' : 'truncate'}`}>{result.labelNode ?? result.label}</span>
      {detailNode ? <span className="hidden max-w-[48%] truncate text-[11px] text-neutral-500 sm:block">{detailNode}</span> : detail && <span className="hidden max-w-[48%] truncate text-[11px] text-neutral-500 sm:block">{detail}</span>}
    </button>
  )
}

export function UniversalMenuHierarchyRow({ result, state }: { result: UniversalMenuResult; state: UniversalMenuRenderState }) {
  const detail = result.actionHint ? (state.active ? result.actionHint : undefined) : result.detail
  const detailNode = result.actionHint ? undefined : result.detailNode
  return (
    <button
      type="button"
      disabled={state.disabled}
      onMouseEnter={state.onMouseEnter}
      onClick={(event) => state.onSelect(event)}
      className={rowClassName(state)}
      style={{ paddingLeft: result.flatHierarchy ? 16 : `${16 + (result.depth ?? 0) * 18}px` }}
    >
      {!result.flatHierarchy && (
        <span className="flex w-3 shrink-0 items-center justify-center text-neutral-600">
          {result.disabled ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
        </span>
      )}
      {result.icon && <TabIconView icon={result.icon} />}
      <span className={`min-w-0 flex-1 text-left ${result.labelNode ? '' : 'truncate'}`}>{result.labelNode ?? result.label}</span>
      {detailNode ? <span className="hidden max-w-[44%] truncate text-[11px] text-neutral-500 sm:block">{detailNode}</span> : detail && <span className="hidden max-w-[44%] truncate text-[11px] text-neutral-500 sm:block">{detail}</span>}
    </button>
  )
}

export function UniversalMenuScopeButton({ scope, onClick }: { scope: ScopeDefinition; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-w-0 items-center justify-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-neutral-400 hover:bg-neutral-925 hover:text-neutral-300"
    >
      <span className="rounded bg-neutral-900 px-1 py-0 font-mono text-[9px] leading-4 text-neutral-400">{scope.key}</span>
      <span className="truncate">{scope.label}</span>
    </button>
  )
}

export function UniversalMenuEmptyRow({ children }: { children: ReactNode }) {
  return <div className="px-4 py-4 text-sm text-neutral-500">{children}</div>
}

export function CompactPath({ path }: { path: string }) {
  const homePrefix = path.startsWith('~/') ? '~' : path === '~' ? '~' : ''
  const trimmed = homePrefix ? path.slice(homePrefix.length).replace(/^\/+/, '') : path.replace(/^\/+/, '')
  const absolutePrefix = !homePrefix && path.startsWith('/') ? '/' : ''
  const parts = trimmed.split('/').filter(Boolean)
  return (
    <span className="inline-flex min-w-0 items-center truncate font-mono text-neutral-700">
      {homePrefix && <span className="truncate">{homePrefix}</span>}
      {absolutePrefix && <span className="text-neutral-700">/</span>}
      {parts.map((part, index) => (
        <span key={`${part}-${index}`} className="inline-flex min-w-0 items-center">
          {(homePrefix || absolutePrefix || index > 0) && <span className="px-0.5 text-neutral-700">/</span>}
          <span className="truncate">{part}</span>
        </span>
      ))}
    </span>
  )
}

function UniversalMenuScopeButtons({ scopes, onEnter }: { scopes: ScopeDefinition[]; onEnter: (scope: ScopeDefinition) => void }) {
  return (
    <div className="mt-2 flex items-center justify-between gap-1">
      {scopes.map((scope) => <UniversalMenuScopeButton key={scope.id} scope={scope} onClick={() => onEnter(scope)} />)}
    </div>
  )
}

function recentFolderScopeResults({
  folders,
  loading,
  error,
  query,
  homePath,
  workspaceFolders,
  workspaceId,
  openNewWorkspaceChat,
  startChat,
}: {
  folders?: RecentFolderRow[]
  loading: boolean
  error: unknown
  query: string
  homePath?: string
  workspaceFolders: string[]
  workspaceId?: string
  openNewWorkspaceChat: (path: string) => void
  startChat: (path: string) => Promise<void>
}): UniversalMenuResult[] {
  if (loading) return [disabledRow('recent-folders-loading', 'Loading recent folders…')]
  if (error) return [disabledRow('recent-folders-error', extractTrpcMessage(error))]
  const q = query.trim().toLowerCase()
  const workspaceSet = new Set(workspaceFolders)
  const rows = (folders ?? [])
    .filter((folder) => !q || `${folder.label ?? ''} ${folder.path}`.toLowerCase().includes(q))
    .map((folder): UniversalMenuResult => ({
      id: `recent-folder:${folder.path}`,
      kind: 'folder',
      label: folder.label ?? basename(folder.path),
      detailNode: <CompactPath path={displayPath(folder.path, homePath)} />,
      badge: workspaceSet.has(folder.path) ? 'current workspace' : undefined,
      icon: paneTabIconForType('file'),
      haystack: `${folder.label ?? ''} ${folder.path}`,
      disabled: !workspaceId,
      run: () => startChat(folder.path),
      alternateRun: () => openNewWorkspaceChat(folder.path),
    }))
  return rows.length ? rows : [disabledRow('recent-folders-empty', q ? 'No matching recent folders.' : 'No recent folders yet.')]
}

function workTreeScopeResults({
  worktrees,
  configs,
  loading,
  configsLoading,
  error,
  configsError,
  query,
  homePath,
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
  homePath?: string
  workspaceId?: string
  openNewWorkspaceChat: (selection: NewAgentChatSelection) => void
  startChat: (path: string) => Promise<void>
}): UniversalMenuResult[] {
  if (loading || configsLoading) return [disabledRow('worktrees-loading', 'Loading work trees…')]
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
    if (q && !repoWorktrees.length && !config) continue
    const groupId = `worktree-repo:${repoLabel}`
    rows.push(groupRow(groupId, repoLabel, 0, config?.originUrl ?? undefined))
    for (const worktree of repoWorktrees) {
      rows.push({
        id: `worktree:${worktree.id}`,
        kind: 'worktree',
        label: worktree.worktreeName,
        detailNode: <CompactPath path={displayPath(worktree.workingDir, homePath)} />,
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

function shellScopeResults({ shells, loading, error, query, homePath, openShell }: { shells?: ShellRow[]; loading: boolean; error: unknown; query: string; homePath?: string; openShell: (shellId: string) => void }): UniversalMenuResult[] {
  if (loading) return [disabledRow('shells-loading', 'Loading shells…')]
  if (error) return [disabledRow('shells-error', extractTrpcMessage(error))]
  const q = query.trim().toLowerCase()
  const rows = (shells ?? [])
    .filter((shell) => !q || `${shell.title ?? ''} ${shell.id} ${shell.cwd} ${shell.ownerKind ?? ''}`.toLowerCase().includes(q))
    .map((shell): UniversalMenuResult => ({
      id: `shell:${shell.id}`,
      kind: 'shell',
      label: shell.title || `shell ${shell.id.slice(-6)}`,
      detailNode: <CompactPath path={displayPath(shell.cwd, homePath)} />,
      icon: paneTabIconForType('shell'),
      haystack: `${shell.title ?? ''} ${shell.id} ${shell.cwd}`,
      run: () => openShell(shell.id),
    }))
  return rows.length ? rows : [disabledRow('shells-empty', q ? 'No matching shells.' : 'No shells in this workspace.')]
}

function webScopeResults({ items, query, faviconRecords, openContent }: { items: UniversalMenuContextItem[]; query: string; faviconRecords: Record<string, FaviconCacheRecord>; openContent: (content: PaneContent) => void }): UniversalMenuResult[] {
  const q = query.trim().toLowerCase()
  const directUrl = webQueryUrl(query)
  const rows: UniversalMenuResult[] = []
  if (directUrl) {
    rows.push({
      id: `web-url:${directUrl}`,
      kind: 'browser-tab',
      label: directUrl.replace(/^https?:\/\//, ''),
      detail: directUrl,
      icon: browserTabIconForUrl({ url: directUrl, records: faviconRecords }),
      haystack: directUrl,
      run: () => openContent({ type: 'browser', url: directUrl }),
    })
  }
  rows.push(...items
    .filter((item) => item.kind === 'browser-tab')
    .filter((item) => !q || `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(q))
    .map((item): UniversalMenuResult => ({
      id: `web:${item.id}`,
      kind: 'browser-tab',
      label: item.label,
      detail: item.detail,
      icon: item.content.type === 'browser' ? browserTabIconForUrl({ url: item.content.url, records: faviconRecords }) : paneTabIconForType('browser'),
      haystack: `${item.label} ${item.detail ?? ''}`,
      run: () => openContent(item.content),
    })))
  return rows.length ? rows : [disabledRow('web-empty', q ? 'No matching pages.' : 'No browser pages in this workspace.')]
}

function webQueryUrl(query: string): string | null {
  const value = query.trim()
  if (!value || /\s/.test(value)) return null
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`
  try {
    const url = new URL(withProtocol)
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function workspaceScopeResults({ tree, loading, error, query, switchWorkspace }: { tree?: WorkspaceTreeNode[]; loading: boolean; error: unknown; query: string; switchWorkspace: (workspaceId: string) => void }): UniversalMenuResult[] {
  if (loading) return [disabledRow('workspaces-loading', 'Loading workspaces…')]
  if (error) return [disabledRow('workspaces-error', extractTrpcMessage(error))]
  const rows = flattenWorkspaceRows(tree ?? [], query, switchWorkspace)
  return rows.length ? rows : [disabledRow('workspaces-empty', query.trim() ? 'No matching workspaces.' : 'No workspaces.')]
}

function findFilesScopeResults({ roots, files, loading, error, query, homePath, openFile }: { roots: string[]; files?: GitFileRow[]; loading: boolean; error: unknown; query: string; homePath?: string; openFile: (path: string) => void }): UniversalMenuResult[] {
  if (roots.length === 0) return [disabledRow('find-files-no-roots', 'Open a chat in a folder to search git-tracked files.')]
  if (loading) return [disabledRow('find-files-loading', 'Loading files…')]
  if (error) return [disabledRow('find-files-error', extractTrpcMessage(error))]
  const rows: UniversalMenuResult[] = []
  const filesByRoot = new Map<string, GitFileRow[]>()
  for (const file of files ?? []) {
    const rootFiles = filesByRoot.get(file.root)
    if (rootFiles) rootFiles.push(file)
    else filesByRoot.set(file.root, [file])
  }
  for (const [root, rootFiles] of filesByRoot) {
    const groupId = `file-root:${root}`
    rows.push(groupRow(groupId, basename(root), 0, displayPath(root, homePath)))
    for (const file of rootFiles) {
      rows.push({
        id: `file:${file.root}:${file.relativePath}`,
        kind: 'file',
        label: file.relativePath,
        labelNode: <FilePathLabel path={file.relativePath} />,
        parentId: groupId,
        depth: 1,
        flatHierarchy: true,
        icon: paneTabIconForType('file'),
        haystack: `${file.relativePath} ${file.path}`,
        run: () => openFile(file.path),
      })
    }
  }
  return rows.length ? rows : [disabledRow('find-files-empty', query.trim() ? 'No matching tracked files.' : 'No tracked files found in open chat folders.')]
}

function groupRow(id: string, label: string, depth: number, detail?: string): UniversalMenuResult {
  return { id, kind: 'action', label, detail, depth, disabled: true, haystack: label, run: () => undefined }
}

function disabledRow(id: string, label: string): UniversalMenuResult {
  return { id, kind: 'action', label, haystack: label, disabled: true, run: () => undefined }
}

function placeholderScopeResults(scope: ScopeDefinition): UniversalMenuResult[] {
  return [
    {
      id: `placeholder:${scope.id}`,
      kind: 'scope',
      label: scope.placeholder,
      detail: 'Placeholder for Task 1 review',
      badge: scope.key,
      haystack: scope.placeholder,
      disabled: true,
      run: () => undefined,
    },
    {
      id: `hierarchy-preview:${scope.id}`,
      kind: scope.id === 'workspaces' ? 'workspace' : 'bookmark',
      label: 'Hierarchy row preview',
      detail: 'Default nested result variant',
      badge: 'preview',
      depth: 1,
      parentId: `placeholder:${scope.id}`,
      haystack: 'hierarchy row preview nested result',
      disabled: true,
      run: () => undefined,
    },
  ]
}

function flattenWorkspaceRows(tree: WorkspaceTreeNode[], query: string, switchWorkspace: (workspaceId: string) => void): UniversalMenuResult[] {
  const q = query.trim().toLowerCase()
  const rows: UniversalMenuResult[] = []

  function visit(nodes: WorkspaceTreeNode[], depth: number, ancestors: Array<{ id: string; name: string }>) {
    for (const node of nodes) {
      if (node.type === 'folder') {
        visit(node.children, depth + 1, [...ancestors, { id: node.folder.id, name: node.folder.name }])
        continue
      }
      const pathParts = [...ancestors.map((ancestor) => ancestor.name), node.workspace.name]
      const searchable = pathParts.join(' ')
      if (q && !searchable.toLowerCase().includes(q)) continue
      let currentDepth = 0
      for (const ancestor of ancestors) {
        const id = `workspace-folder:${ancestor.id}:${node.workspace.id}`
        rows.push(groupRow(id, ancestor.name, currentDepth))
        currentDepth += 1
      }
      rows.push({
        id: `workspace:${node.workspace.id}`,
        kind: 'workspace',
        label: node.workspace.name,
        parentId: ancestors.at(-1)?.id,
        depth: currentDepth,
        icon: paneTabIconForType('file'),
        haystack: searchable,
        run: () => switchWorkspace(node.workspace.id),
      })
    }
  }

  visit(tree, 0, [])
  return rows
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function displayPath(path: string, home: string | null | undefined): string {
  if (!home) return path
  const normalizedHome = home.replace(/\/+$/, '')
  const normalizedPath = path.replace(/\/+$/, '')
  if (normalizedPath === normalizedHome) return '~'
  if (normalizedPath.startsWith(`${normalizedHome}/`)) return `~/${normalizedPath.slice(normalizedHome.length + 1)}`
  return path
}

function isPathLikeInput(value: string): boolean {
  const trimmed = value.trimStart()
  return trimmed.startsWith('~') || trimmed.includes('/')
}

function rowClassName(state: UniversalMenuRenderState): string {
  const base = 'flex w-full items-center gap-3 px-4 py-2 text-sm'
  if (state.disabled) return `${base} cursor-default text-neutral-600`
  return `${base} cursor-pointer ${state.active ? 'bg-highlight text-neutral-100' : 'text-neutral-300'}`
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
