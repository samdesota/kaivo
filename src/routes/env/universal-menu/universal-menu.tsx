import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, EllipsisVertical, Plus } from 'lucide-react'
import { OverlayShell } from '../../../components/overlay-shell'
import { Button, Field, Input } from '../../../components/ui'
import { FilePathLabel } from '../../../components/file-path-label'
import { paneTabIconForType, TabIconView, type TabIcon } from '../../../components/tab-icon'
import { envTrpc } from '../../../env-trpc'
import { trpc } from '../../../trpc'
import { browserTabIconForUrl, faviconOriginForUrl, type FaviconCacheByOrigin } from '../../../lib/favicon-cache'
import { buildWebSearchUrl, matchBookmarks, resolveBrowserAddress } from '../../../lib/browser-navigation'
import { extractTrpcMessage } from '../../../lib/utils'
import type { PaneContent } from '../shell/tab-state'
import { defaultWorkspaceName, resolveWorkspaceName, type NewAgentChatSelection, type NewAgentChatWorkspaceMode } from '../agent/new-agent-chat-state'
import { WorkspaceModeControl } from '../agent/new-agent-chat-modal'
import { useBookmarksStore, type BookmarkRecord } from '../../workspace/bookmarks-store'
import { useWorkspaceSidebarTree } from '../../../data/modules/workspace-folders'

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
  run: () => void | Promise<void>
  alternateRun?: () => void | Promise<void>
  actions?: UniversalMenuResultAction[]
  drill?: () => void
  keepOpen?: boolean
}

export interface UniversalMenuResultAction {
  id: string
  label: string
  key: string
  run: () => void | Promise<void>
}

export interface UniversalMenuContextItem {
  id: string
  kind: 'shell' | 'browser-tab'
  label: string
  detail?: string
  content: PaneContent
}

export type UniversalMenuInitialIntent = 'default' | 'global'
export type UniversalMenuInitialScope = 'web'
export type UniversalMenuOpenTarget = 'workspace' | 'global'

export type UniversalMenuWorkspaceBootstrap =
  | { type: 'folder'; workspaceId: string; path: string }
  | { type: 'worktree'; workspaceId: string; path: string; repoId: string; name?: string }
  | { type: 'repoConfig'; workspaceId: string; configId: string; worktreeName: string }

export type UniversalMenuWorkspaceBootstrapRequest = {
  workspaceCreate: {
    name: string
    folderId?: string | null
    nameSource: 'explicit' | 'folder_path' | 'worktree'
    sourceKind: 'folder' | 'worktree' | 'repo_config'
    sourcePath: string
  }
  bootstrap:
    | { type: 'folder'; path: string }
    | { type: 'worktree'; path: string; repoId: string; name?: string }
    | { type: 'repoConfig'; configId: string; worktreeName: string }
}

export type UniversalMenuChatBootstrap =
  | { type: 'folder'; workspaceId: string; path: string }
  | { type: 'worktree'; workspaceId: string; path: string; repoId: string; name?: string }
  | { type: 'repoConfig'; workspaceId: string; configId: string; worktreeName: string }

interface AgentSessionRow {
  id: string
  workingDir: string | null
  title?: string | null
  status?: string
  lastActivityAt?: Date | string
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
  updatedAt?: string | Date
  createdAt?: string | Date
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
  actionMenuOpen: boolean
  onOpenActions: () => void
  onRunAction: (action: UniversalMenuResultAction) => void
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
  renderResult: renderFileSystemResult,
  handleKeyDown(event, context) {
    if (event.key === 'ArrowRight') {
      const result = context.activeResult
      if (result?.kind !== 'folder' || !result.detail) return false
      event.preventDefault()
      context.drillIntoFolder(result.detail)
      context.setActive(0)
      return true
    }
    if (event.key === 'ArrowLeft') {
      const parent = parentPath(context.browsePath)
      if (!parent) return false
      event.preventDefault()
      context.drillIntoFolder(parent)
      context.setActive(0)
      return true
    }
    return false
  },
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
  onCreateShell,
  onCreateChat,
  onCreatedChat,
  onBootstrapWorkspace,
  onSwitchWorkspace,
  onCloseTab,
  onToggleAgentPane,
  onToggleSidebar,
  onOpenSettings,
  initialIntent = 'default',
  initialScope,
  initialOpenTarget = 'workspace',
}: {
  open: boolean
  workspaceName?: string
  workspaceId?: string
  workspaceFolderId?: string | null
  activeSessionId?: string | null
  hasActiveTab: boolean
  contextItems?: UniversalMenuContextItem[]
  onClose: () => void
  onOpenContent?: (content: PaneContent, target?: UniversalMenuOpenTarget) => void
  onCreateShell?: (cwd?: string) => void
  onCreateChat?: (bootstrap: UniversalMenuChatBootstrap) => void
  onCreatedChat?: (sessionId: string, workspaceId?: string) => void
  onBootstrapWorkspace?: (request: UniversalMenuWorkspaceBootstrapRequest) => void
  onSwitchWorkspace?: (workspaceId: string) => void
  onCloseTab: () => void
  onToggleAgentPane?: () => void
  onToggleSidebar?: () => void
  onOpenSettings?: () => void
  initialIntent?: UniversalMenuInitialIntent
  initialScope?: UniversalMenuInitialScope
  initialOpenTarget?: UniversalMenuOpenTarget
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [mouseMoved, setMouseMoved] = useState(false)
  const [scope, setScope] = useState<{ definition: ScopeDefinition; query: string } | null>(null)
  const [intent, setIntent] = useState<UniversalMenuInitialIntent>(initialIntent)
  const [folderPath, setFolderPath] = useState<string | undefined>(undefined)
  const [detailsSelection, setDetailsSelection] = useState<NewAgentChatSelection | null>(null)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState({ value: '', edited: false })
  const [parentFolderId, setParentFolderId] = useState<string | null>(null)
  const [detailsWorkspaceMode, setDetailsWorkspaceMode] = useState<NewAgentChatWorkspaceMode>('new')
  const [detailsWorkspaceId, setDetailsWorkspaceId] = useState<string | undefined>(workspaceId)
  const [actionMenuOpen, setActionMenuOpen] = useState(false)
  const [closedChatsOpen, setClosedChatsOpen] = useState(false)
  const globalIntent = intent === 'global'
  const previousFileSystemResultsRef = useRef<UniversalMenuResult[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const folderProbe = envTrpc.fs.browseHome.useQuery(
    { path: undefined },
    { enabled: open, refetchOnWindowFocus: false, staleTime: 30_000 },
  )
  const folderBrowsePlan = useMemo(() => {
    if (scope?.definition.id !== 'open-folder' || !isPathLikeInput(query)) return null
    const probe = folderProbe.data as FolderBrowseData | undefined
    return pathBrowsePlan(query, { home: probe?.home ?? undefined, defaultPath: probe?.defaultPath ?? undefined })
  }, [folderProbe.data, query, scope?.definition.id])
  const sessions = envTrpc.agent.sessionList.useQuery(workspaceId ? { workspaceId } : undefined, {
    enabled: open && !!workspaceId,
    staleTime: 5_000,
  })
  const recentFolders = envTrpc.repo.listRecentFolders.useQuery(undefined, { enabled: open && (scope?.definition.id === 'recent-folders' || globalIntent), staleTime: 5_000 })
  const repoConfigs = envTrpc.repo.listConfigs.useQuery(undefined, { enabled: open && (scope?.definition.id === 'work-trees' || !!detailsSelection || globalIntent), staleTime: 5_000 })
  const worktrees = envTrpc.repo.listWorktrees.useQuery(undefined, { enabled: open && scope?.definition.id === 'work-trees', staleTime: 5_000 })
  const shells = envTrpc.shell.list.useQuery(workspaceId ? { workspaceId } : undefined, { enabled: open && !!workspaceId && (scope?.definition.id === 'shells' || (!scope && !query.trim())), staleTime: 5_000 })
  const workspaceTree = trpc.workspace.listTree.useQuery(undefined, { enabled: open && scope?.definition.id === 'workspaces', staleTime: 15_000 })
  const localWorkspaceTree = useWorkspaceSidebarTree()
  const envUtils = envTrpc.useUtils()
  const startChat = envTrpc.agent.sessionStart.useMutation()
  const reopenChat = envTrpc.agent.sessionReopen.useMutation()
  const disposeShell = envTrpc.shell.dispose.useMutation()
  const cloneConfig = envTrpc.repo.cloneConfig.useMutation()
  const createDirectory = envTrpc.fs.createDirectory.useMutation()
  const createWorkspace = trpc.workspace.create.useMutation()
  const upsertWorkspaceResource = trpc.workspace.upsertResource.useMutation()
  const bookmarksStore = useBookmarksStore()
  const bookmarkDebugSignature = useMemo(() => bookmarksStore.bookmarks
    .map((bookmark) => `${bookmark.id}:${bookmark.updatedAt.getTime()}`)
    .join('|'), [bookmarksStore.bookmarks])
  const folderBrowse = envTrpc.fs.browseHome.useQuery(
    { path: folderBrowsePlan ? folderBrowsePlan.dir : folderPath },
    { enabled: open && scope?.definition.id === 'open-folder', refetchOnWindowFocus: false },
  )
  const faviconOrigins = useMemo(() => Array.from(new Set(
    [
      ...contextItems
        .filter((item) => item.kind === 'browser-tab' && item.content.type === 'browser')
        .map((item) => item.content.type === 'browser' ? faviconOriginForUrl(item.content.url) : null),
      ...bookmarksStore.bookmarks.map((bookmark) => bookmark.origin),
    ]
      .filter((origin): origin is string => Boolean(origin)),
  )), [bookmarksStore.bookmarks, contextItems])
  const faviconCache = trpc.favicon.getByOrigins.useQuery(
    { origins: faviconOrigins },
    { enabled: open && faviconOrigins.length > 0, staleTime: 60_000 },
  )
  const fileRoots = useMemo(() => Array.from(new Set(((sessions.data as AgentSessionRow[] | undefined) ?? []).map((session) => session.workingDir).filter((dir): dir is string => Boolean(dir)))), [sessions.data])
  const activeCwd = activeSessionId
    ? ((sessions.data as AgentSessionRow[] | undefined) ?? []).find((session) => session.id === activeSessionId)?.workingDir ?? undefined
    : undefined
  const gitFiles = envTrpc.fs.searchGitTrackedFiles.useQuery(
    { roots: fileRoots, query, limit: 160 },
    { enabled: open && scope?.definition.id === 'find-files' && fileRoots.length > 0, staleTime: 10_000 },
  )
  const homePath = (folderProbe.data as FolderBrowseData | undefined)?.home ?? undefined

  const enterScope = useCallback((definition: ScopeDefinition, initialQuery: string) => {
    setScope({ definition, query: initialQuery })
    setQuery(initialQuery)
    if (definition.id === 'open-folder') setFolderPath(undefined)
    setActive(0)
    setMouseMoved(false)
  }, [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    setMouseMoved(false)
    setScope(initialScope ? { definition: scopeControllerById.get(initialScope)!.definition, query: '' } : null)
    setIntent(initialIntent)
    setDetailsSelection(null)
    setDetailsError(null)
    setWorkspaceNameDraft({ value: '', edited: false })
    setParentFolderId(null)
    setDetailsWorkspaceMode('new')
    setDetailsWorkspaceId(workspaceId)
    setActionMenuOpen(false)
    setClosedChatsOpen(false)
  }, [initialIntent, initialScope, open, workspaceId])

  useEffect(() => {
    if (!open) return
    console.info(`[universal-menu-bookmarks] ${JSON.stringify({
      event: 'bookmarks:update',
      bookmarkCount: bookmarksStore.bookmarks.length,
      signature: bookmarkDebugSignature,
      query,
      scope: scope?.definition.id ?? null,
      sample: bookmarksStore.bookmarks.slice(0, 5).map((bookmark) => ({ id: bookmark.id, title: bookmark.title, url: bookmark.url, updatedAt: bookmark.updatedAt.getTime() })),
    })}`)
  }, [bookmarkDebugSignature, open, query, scope?.definition.id])

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
    const commandScopes = globalIntent ? scopes.filter((definition) => definition.id === 'web' || definition.id === 'workspaces') : scopes
    const out: UniversalMenuResult[] = commandScopes.map((definition) => ({
      id: `scope:${definition.id}`,
      kind: 'scope',
      label: definition.label,
      badge: definition.key,
      haystack: `${definition.label} ${definition.detail} ${definition.key}`,
      run: () => enterScope(definition, ''),
    }))

    if (globalIntent) {
      out.push(
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
    }

    out.push({
      id: 'action:new-shell',
      kind: 'action',
      label: 'New shell',
      haystack: 'new shell terminal command workspace',
      run: () => onCreateShell?.(activeCwd),
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

    if (workspaceId) {
      const archivedCount = ((sessions.data as AgentSessionRow[] | undefined) ?? []).filter((session) => session.status === 'archived').length
      out.push({
        id: 'action:closed-chats',
        kind: 'action',
        label: 'Closed chats',
        detail: archivedCount > 0 ? `${archivedCount} previous chat${archivedCount === 1 ? '' : 's'}` : 'No closed chats',
        haystack: 'closed chats previous archived reopen agent chat history',
        keepOpen: true,
        run: () => {
          setClosedChatsOpen(true)
          setQuery('')
          setActive(0)
          setMouseMoved(false)
          setActionMenuOpen(false)
        },
      })
    }

    if (workspaceId) {
      out.push({
        id: 'action:toggle-agent-pane',
        kind: 'action',
        label: 'Collapse agent chat',
        haystack: 'collapse expand toggle agent pane chat',
        disabled: !onToggleAgentPane,
        run: () => onToggleAgentPane?.(),
      })
    }

    out.push(
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
  }, [activeCwd, enterScope, globalIntent, hasActiveTab, onCloseTab, onCreateShell, onOpenSettings, onToggleAgentPane, onToggleSidebar, sessions.data, workspaceId])

  const newWorkspaceSections = useMemo(() => {
    const configs = [...((repoConfigs.data as RepoConfigRow[] | undefined) ?? [])]
      .sort((a, b) => timestampMs(b.updatedAt ?? b.createdAt) - timestampMs(a.updatedAt ?? a.createdAt))
      .map((config): UniversalMenuResult => ({
        id: `new-workspace-config:${config.id}`,
        kind: 'worktree',
        label: config.githubFullName ?? config.name,
        detail: config.originUrl ?? undefined,
        icon: paneTabIconForType('file'),
        haystack: `${config.name} ${config.githubFullName ?? ''} ${config.originUrl ?? ''}`,
        run: () => openDetails({ type: 'repoConfig', configId: config.id, worktreeName: '' }),
      }))

    const folders = ((recentFolders.data as RecentFolderRow[] | undefined) ?? [])
      .map((folder): UniversalMenuResult => ({
        id: `new-workspace-folder:${folder.path}`,
        kind: 'folder',
        label: folder.label ?? basename(folder.path),
        detailNode: <CompactPath path={displayPath(folder.path, homePath)} />,
        icon: paneTabIconForType('file'),
        haystack: `${folder.label ?? ''} ${folder.path}`,
        run: () => openDetails({ type: 'folder', path: folder.path }),
      }))

    return [
      { id: 'repo-configs', label: 'Recently used repo configs', results: configs },
      { id: 'recent-folders', label: 'Global recent folders', results: folders },
    ].filter((section) => section.results.length > 0)
  }, [homePath, recentFolders.data, repoConfigs.data])

  const newWorkspaceCount = newWorkspaceSections.reduce((sum, section) => sum + section.results.length, 0)
  const newWorkspaceResults = useMemo(() => newWorkspaceSections.flatMap((section) => section.results), [newWorkspaceSections])

  const closedChatResults = useMemo(() => ((sessions.data as AgentSessionRow[] | undefined) ?? [])
    .filter((session) => session.status === 'archived')
    .map((session): UniversalMenuResult => {
      const label = session.title ?? session.id.slice(-8)
      return {
        id: `closed-chat:${session.id}`,
        kind: 'action',
        label,
        detail: session.lastActivityAt ? new Date(session.lastActivityAt).toLocaleDateString() : undefined,
        badge: 'closed',
        haystack: `closed chat previous archived ${label} ${session.id}`,
        disabled: !workspaceId,
        run: async () => {
          await reopenChat.mutateAsync({ sessionId: session.id })
          await envUtils.agent.sessionList.invalidate(workspaceId ? { workspaceId } : undefined)
          onCreatedChat?.(session.id, workspaceId)
        },
      }
    }), [envUtils.agent.sessionList, onCreatedChat, reopenChat, sessions.data, workspaceId])

  const visibleResults = useMemo(() => {
    if (closedChatsOpen) {
      const filter = query.trim().toLowerCase()
      if (!filter) return closedChatResults
      return closedChatResults.filter((result) => result.haystack.toLowerCase().includes(filter))
    }
    if (scope?.definition.id === 'open-folder') {
      const next = openFolderScopeResults({
        data: folderBrowse.data as FolderBrowseData | undefined,
        error: folderBrowse.error,
        loading: folderBrowse.isLoading,
        filter: folderBrowsePlan ? folderBrowsePlan.filter : query,
        workspaceId,
        startChat: async (path) => {
          if (globalIntent || !workspaceId) {
            openDetails({ type: 'folder', path })
            return
          }
          onCreateChat?.({ type: 'folder', workspaceId, path })
        },
        openFile: (path) => onOpenContent?.({ type: 'file', path, absolute: true }),
        drillFolder: drillIntoFolder,
        createFolder: async (parentPath, name) => {
          const created = await createDirectory.mutateAsync({ parentPath, name }) as FolderBrowseDir
          await envUtils.fs.browseHome.invalidate()
          drillIntoFolder(created.path)
        },
        openNewWorkspaceChat: (path) => openDetails({ type: 'folder', path }),
      })
      if (folderBrowse.isLoading && previousFileSystemResultsRef.current.length > 0) return previousFileSystemResultsRef.current
      if (!folderBrowse.isLoading && next.length > 0) previousFileSystemResultsRef.current = next
      return next
    }
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
          if (globalIntent || !workspaceId) {
            openDetails({ type: 'folder', path })
            return
          }
          onCreateChat?.({ type: 'folder', workspaceId, path })
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
          onCreateChat?.({ type: 'folder', workspaceId, path })
        },
      })
    }
    if (scope?.definition.id === 'shells') {
      return shellScopeResults({
        shells: shells.data as ShellRow[] | undefined,
        loading: shells.isLoading,
        error: shells.error,
        query,
        homePath,
        openShell: (shellId) => onOpenContent?.({ type: 'shell', shellId }),
        terminateShell: (shellId) => terminateShell(shellId),
      })
    }
    if (scope?.definition.id === 'web') {
      return webScopeResults({
        items: contextItems,
        bookmarks: bookmarksStore.bookmarks,
        query,
        faviconRecords: (faviconCache.data ?? {}) as FaviconCacheByOrigin,
        openContent: (content) => onOpenContent?.(content, globalIntent ? 'global' : initialOpenTarget),
      })
    }
    if (scope?.definition.id === 'workspaces') {
      return workspaceScopeResults({ tree: workspaceTree.data as WorkspaceTreeNode[] | undefined, loading: workspaceTree.isLoading, error: workspaceTree.error, query, switchWorkspace: (workspaceId) => onSwitchWorkspace?.(workspaceId) })
    }
    if (scope?.definition.id === 'find-files') {
      return findFilesScopeResults({ roots: fileRoots, files: gitFiles.data as GitFileRow[] | undefined, loading: gitFiles.isLoading, error: gitFiles.error, query, homePath, openFile: (path) => onOpenContent?.({ type: 'file', path, absolute: true }) })
    }
    if (scope) return placeholderScopeResults(scope.definition)
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return []
    const globalWorkspaceResults = globalIntent
      ? newWorkspaceResults
        .map((result) => ({ result, score: fuzzyScore(result.haystack.toLowerCase(), trimmed) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.result)
      : []
    return normalSearchResults({
      bookmarks: bookmarksStore.bookmarks,
      commandResults: [...globalWorkspaceResults, ...commandResults],
      faviconRecords: (faviconCache.data ?? {}) as FaviconCacheByOrigin,
      query,
      openContent: (content) => onOpenContent?.(content, globalIntent ? 'global' : initialOpenTarget),
    })
  }, [bookmarksStore.bookmarks, closedChatResults, closedChatsOpen, commandResults, contextItems, createDirectory, disposeShell, envUtils.fs.browseHome, envUtils.shell.list, faviconCache.data, fileRoots, folderBrowse.data, folderBrowse.error, folderBrowse.isLoading, folderBrowsePlan, gitFiles.data, gitFiles.error, gitFiles.isLoading, globalIntent, homePath, initialOpenTarget, newWorkspaceResults, onCreateChat, onOpenContent, onSwitchWorkspace, query, recentFolders.data, recentFolders.error, recentFolders.isLoading, repoConfigs.data, repoConfigs.error, repoConfigs.isLoading, scope, shells.data, shells.error, shells.isLoading, workspaceId, workspaceTree.data, workspaceTree.error, workspaceTree.isLoading, worktrees.data, worktrees.error, worktrees.isLoading])

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
        disabled: !workspaceId,
          run: () => {
            if (!workspaceId || !session.workingDir) return
            onCreateChat?.({ type: 'folder', workspaceId, path: session.workingDir })
          },
          alternateRun: () => openDetails({ type: 'folder', path: session.workingDir! }),
      })
      }
    }

    const shellMap = new Map<string, UniversalMenuResult>()
    for (const shell of (shells.data as ShellRow[] | undefined) ?? []) {
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
        actions: [{ id: 'terminate', label: 'Terminate shell', key: 't', run: () => terminateShell(shell.id) }],
      })
    }
    for (const item of contextItems.filter((item) => item.kind === 'shell')) {
      const shellId = item.content.type === 'shell' ? item.content.shellId : item.id
      if (workspaceId && shells.data && !(shells.data as ShellRow[]).some((shell) => shell.id === shellId && shell.alive !== false)) continue
      if (shellMap.has(shellId)) continue
      shellMap.set(shellId, {
        id: item.id,
        kind: 'shell',
        label: item.label,
        detail: item.detail ? displayPath(item.detail, homePath) : undefined,
        detailNode: item.detail ? <CompactPath path={displayPath(item.detail, homePath)} /> : undefined,
        icon: paneTabIconForType('shell'),
        haystack: `${item.label} ${item.detail ?? ''}`,
        run: () => onOpenContent?.(item.content),
        actions: [{ id: 'terminate', label: 'Terminate shell', key: 't', run: () => terminateShell(shellId) }],
      })
    }
    const shellResults = [...shellMap.values()]
    return [
      { id: 'folders', label: 'Recent workspace folders', results: [...folderMap.values()] },
      { id: 'shells', label: 'Shells', results: shellResults },
      { id: 'closed-chats', label: 'Closed chats', results: closedChatResults.slice(0, 5) },
    ].filter((section) => section.results.length > 0)
  }, [closedChatResults, contextItems, disposeShell, envUtils.shell.list, faviconCache.data, homePath, onCreateChat, onOpenContent, sessions.data, shells.data, workspaceId])

  const contextualCount = contextualSections.reduce((sum, section) => sum + section.results.length, 0)
  const contextualResults = useMemo(() => contextualSections.flatMap((section) => section.results), [contextualSections])

  const openFolderFilter = scope?.definition.id === 'open-folder'
    ? (folderBrowsePlan ? folderBrowsePlan.filter : query).trim()
    : ''

  useEffect(() => {
    if (!scope && !query.trim() && !closedChatsOpen) return
    if (active >= visibleResults.length) setActive(0)
  }, [active, closedChatsOpen, query, scope, visibleResults.length])

  useEffect(() => {
    if (scope || query.trim() || closedChatsOpen) return
    const length = globalIntent ? newWorkspaceResults.length : contextualResults.length
    if (active >= length) setActive(0)
  }, [active, closedChatsOpen, contextualResults.length, globalIntent, newWorkspaceResults.length, query, scope])

  useEffect(() => {
    if (scope?.definition.id !== 'open-folder') return
    setActive(openFolderFilter && visibleResults.length > 1 ? 1 : 0)
  }, [folderBrowse.data, openFolderFilter, scope?.definition.id, visibleResults.length])

  const currentScopeController = scope ? scopeControllerById.get(scope.definition.id) : undefined

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
      const selectedActions = selectedResultActions()
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
      if (event.key === 'Tab' && !detailsSelection) {
        event.preventDefault()
        setIntent((current) => current === 'global' ? 'default' : 'global')
        setActive(0)
        setMouseMoved(false)
        setActionMenuOpen(false)
        return
      }
      if (event.key === 'Backspace' && scope && query.length === 0) {
        event.preventDefault()
        exitScope()
        return
      }
      if (event.key === 'Backspace' && closedChatsOpen && query.length === 0) {
        event.preventDefault()
        exitClosedChats()
        return
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const length = scope || query.trim() || closedChatsOpen ? visibleResults.length : globalIntent ? newWorkspaceResults.length : contextualResults.length
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
        if (!scope && !query.trim() && globalIntent) void pickNewWorkspace(active)
        else if (!scope && !query.trim() && !closedChatsOpen) void pickContextual(active, { shiftKey: event.shiftKey })
        else void pick(active, { shiftKey: event.shiftKey })
        return
      }
      const handled = currentScopeController?.handleKeyDown?.(event, {
        activeResult: visibleResults[active],
        browsePath: folderBrowsePlan?.dir ?? (folderBrowse.data as FolderBrowseData | undefined)?.path,
        drillIntoFolder,
        setActive: activateIndex,
      })
      if (handled) return
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  if (!open) return null

  function setInputValue(value: string) {
    if (!scope && !closedChatsOpen) {
      if (isPathLikeInput(value) && resolveBrowserAddress(value).kind !== 'url') {
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

  async function runAction(action: UniversalMenuResultAction) {
    await action.run()
    setActionMenuOpen(false)
  }

  function selectedResultActions(): UniversalMenuResultAction[] {
    const result = !scope && !query.trim() && globalIntent
      ? newWorkspaceResults[active]
      : !scope && !query.trim()
        ? contextualResults[active]
        : visibleResults[active]
    return result?.actions ?? []
  }

  async function pick(index: number, event?: { shiftKey?: boolean }) {
    const result = visibleResults[index]
    if (!result || result.disabled) return
    if ((globalIntent || event?.shiftKey) && result.alternateRun) {
      await result.alternateRun()
      return
    }
    await result.run()
    if (result.keepOpen) return
    if (globalIntent && result.id.startsWith('new-workspace-')) return
    onClose()
  }

  async function pickNewWorkspace(index: number) {
    const result = newWorkspaceResults[index]
    if (!result || result.disabled) return
    await result.run()
  }

  async function pickContextual(index: number, event?: { shiftKey?: boolean }) {
    const result = contextualResults[index]
    if (!result || result.disabled) return
    if (event?.shiftKey && result.alternateRun) {
      await result.alternateRun()
      return
    }
    await result.run()
    onClose()
  }

  async function pickAlternate(index: number) {
    const result = visibleResults[index]
    if (!result?.alternateRun) return
    await result.alternateRun()
  }

  async function terminateShell(shellId: string) {
    await disposeShell.mutateAsync({ id: shellId })
    await envUtils.shell.list.invalidate(workspaceId ? { workspaceId } : undefined)
    setActionMenuOpen(false)
  }

  function openDetails(selection: NewAgentChatSelection) {
    setDetailsSelection(selection)
    setDetailsError(null)
    setWorkspaceNameDraft({ value: '', edited: false })
    setParentFolderId(workspaceFolderId ?? null)
    setDetailsWorkspaceMode('new')
    setDetailsWorkspaceId(workspaceId)
    setMouseMoved(false)
    setActionMenuOpen(false)
  }

  async function createDetailsChat() {
    if (!detailsSelection) return
    console.info('[universal-menu] create details submit', {
      selectionType: detailsSelection.type,
      globalIntent,
      workspaceId,
    })
    setDetailsError(null)
    try {
      if (detailsWorkspaceMode === 'new') {
        if (detailsSelection.type === 'repoConfig' && !detailsSelection.worktreeName.trim()) {
          console.info('[universal-menu] create details validation failed', { reason: 'missing-worktree-name' })
          setDetailsError('Name the work tree.')
          return
        }
        const resolved = resolveWorkspaceName(detailsSelection, workspaceNameDraft)
        const workspaceCreate: UniversalMenuWorkspaceBootstrapRequest['workspaceCreate'] = {
          name: resolved.name,
          folderId: parentFolderId,
          nameSource: resolved.source,
          sourceKind: detailsSelection.type === 'folder' ? 'folder' : detailsSelection.type === 'worktree' ? 'worktree' : 'repo_config',
          sourcePath: detailsSelection.type === 'repoConfig' ? detailsSelection.worktreeName.trim() : detailsSelection.path,
        }
        const bootstrap: UniversalMenuWorkspaceBootstrapRequest['bootstrap'] = detailsSelection.type === 'folder'
          ? { type: 'folder', path: detailsSelection.path }
          : detailsSelection.type === 'worktree'
            ? { type: 'worktree', path: detailsSelection.path, repoId: detailsSelection.repoId, name: detailsSelection.name }
            : { type: 'repoConfig', configId: detailsSelection.configId, worktreeName: detailsSelection.worktreeName.trim() }
        console.info('[universal-menu] emit workspace bootstrap', {
          bootstrapType: bootstrap.type,
          workspaceName: workspaceCreate.name,
          sourceKind: workspaceCreate.sourceKind,
        })
        onBootstrapWorkspace?.({ workspaceCreate, bootstrap })
        return
      }

      if (!detailsWorkspaceId) {
        setDetailsError('Choose a workspace.')
        return
      }
      if (detailsSelection.type === 'repoConfig') {
        if (!detailsSelection.worktreeName.trim()) {
          setDetailsError('Name the work tree.')
          return
        }
      }
      onCreateChat?.(detailsSelection.type === 'folder'
        ? { type: 'folder', workspaceId: detailsWorkspaceId, path: detailsSelection.path }
        : detailsSelection.type === 'worktree'
          ? { type: 'worktree', workspaceId: detailsWorkspaceId, path: detailsSelection.path, repoId: detailsSelection.repoId, name: detailsSelection.name }
          : { type: 'repoConfig', workspaceId: detailsWorkspaceId, configId: detailsSelection.configId, worktreeName: detailsSelection.worktreeName.trim() })
    } catch (error) {
      console.error('[universal-menu] create details failed', error)
      setDetailsError(extractTrpcMessage(error))
    }
  }

  function goBackOrClose() {
    if (closedChatsOpen) {
      exitClosedChats()
      return
    }
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
    setFolderPath(undefined)
    setMouseMoved(false)
    setActionMenuOpen(false)
  }

  function exitClosedChats() {
    setClosedChatsOpen(false)
    setQuery('')
    setActive(0)
    setMouseMoved(false)
    setActionMenuOpen(false)
  }

  const placeholder = closedChatsOpen ? 'Search closed chats…' : scope ? `Search ${scope.definition.label.toLowerCase()}…` : globalIntent ? 'Search web, bookmarks, folders, or commands' : 'Search commands'
  const resultCount = scope || query.trim() || closedChatsOpen ? visibleResults.length : globalIntent ? newWorkspaceCount : contextualCount
  const footerHints = currentScopeController?.footerHints ?? []
  const showActionHint = selectedResultActions().length > 0
  const selectedConfig = detailsSelection?.type === 'repoConfig' ? (repoConfigs.data as RepoConfigRow[] | undefined)?.find((config) => config.id === detailsSelection.configId) : null
  const generatedWorkspaceName = defaultWorkspaceName(detailsSelection).name
  const workspaceNameValue = resolveWorkspaceName(detailsSelection, workspaceNameDraft).name
  const detailsBusy = cloneConfig.isPending || createWorkspace.isPending || upsertWorkspaceResource.isPending || startChat.isPending
  const detailsCreatingNewWorkspace = detailsWorkspaceMode === 'new'

  if (detailsSelection) {
    return (
      <OverlayShell
        onClose={onClose}
        panelClassName="relative !max-w-[700px] !border-neutral-800 pb-7"
        footerClassName="absolute inset-x-0 bottom-0 border-t border-white/5 bg-neutral-950/55 backdrop-blur-xl shadow-[0_-1px_6px_rgba(0,0,0,0.12)]"
        footer={<><span>tab toggle workspace</span><span>esc close</span><span className="ml-auto">{detailsCreatingNewWorkspace ? 'new workspace' : 'existing workspace'}</span></>}
      >
        <div>
          <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-3 py-2">
            <button onClick={() => setDetailsSelection(null)} className="rounded px-2 py-1 text-sm leading-none text-neutral-400 hover:bg-highlight hover:text-neutral-100" aria-label="Back">‹</button>
            <div className="text-sm font-medium text-neutral-200">{detailsCreatingNewWorkspace ? 'Create workspace' : 'Create chat'}</div>
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
            mode={detailsWorkspaceMode}
            onModeChange={setDetailsWorkspaceMode}
            existingWorkspaceName={workspaceName}
            selectedWorkspaceId={detailsWorkspaceId}
            workspaceTree={localWorkspaceTree as never[]}
            workspaceNameValue={workspaceNameDraft.edited ? workspaceNameDraft.value : generatedWorkspaceName}
            resolvedWorkspaceName={workspaceNameValue}
            parentFolderId={parentFolderId}
            foldersLoading={false}
            workspacesLoading={false}
            onWorkspaceChange={setDetailsWorkspaceId}
            onParentFolderChange={setParentFolderId}
            onWorkspaceNameChange={(value) => setWorkspaceNameDraft({ value, edited: true })}
          />
          <Button
            variant="secondary"
            onClick={() => void createDetailsChat()}
            disabled={detailsBusy || (detailsSelection.type === 'repoConfig' && !detailsSelection.worktreeName.trim())}
            className="mx-4 mb-4 mt-5"
          >
            {detailsBusy ? 'Creating…' : detailsCreatingNewWorkspace ? (detailsSelection.type === 'repoConfig' ? 'Clone and create workspace' : 'Create workspace') : detailsSelection.type === 'repoConfig' ? 'Clone and create chat' : 'Create chat'}
          </Button>
          {detailsError && <div className="mx-4 mb-4 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">{detailsError}</div>}
          </div>
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
          <span>esc {scope || closedChatsOpen ? 'back' : 'close'}</span>
          <span className="ml-auto">{resultCount} result{resultCount === 1 ? '' : 's'}</span>
        </>
      )}
    >
      <div className="bg-neutral-950 px-3 py-3">
        <div className="flex w-full items-center gap-2 rounded-md border border-neutral-800 bg-neutral-975 px-3 py-2 focus-within:border-neutral-600">
          {closedChatsOpen && <span className="shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 text-[11px] text-neutral-400">Closed chats</span>}
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
        {!closedChatsOpen && !scope && !query.trim() && !globalIntent && <UniversalMenuScopeButtons scopes={scopes} onEnter={(definition) => enterScope(definition, '')} />}
      </div>
      {!closedChatsOpen && !scope && !query.trim() && globalIntent ? (
        <UniversalMenuContextView
          sections={newWorkspaceSections}
          activeIndex={active}
          mouseMoved={mouseMoved}
          onMouseMoved={() => setMouseMoved(true)}
          onActiveChange={activateIndex}
          actionMenuIndex={actionMenuOpen ? active : null}
          onOpenActions={openActions}
          onRunAction={(action) => void runAction(action)}
          loadingFolders={repoConfigs.isLoading || recentFolders.isLoading}
          emptyText="No repo configs or recent folders yet."
          onSelect={(result) => {
            if (result.disabled) return
            void Promise.resolve(result.run())
          }}
        />
      ) : !closedChatsOpen && !scope && !query.trim() ? (
        <UniversalMenuContextView
          sections={contextualSections}
          activeIndex={active}
          mouseMoved={mouseMoved}
          onMouseMoved={() => setMouseMoved(true)}
          onActiveChange={activateIndex}
          actionMenuIndex={actionMenuOpen ? active : null}
          onOpenActions={openActions}
          onRunAction={(action) => void runAction(action)}
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
          renderResult={currentScopeController?.renderResult}
          loading={scope?.definition.id === 'open-folder' && folderBrowse.isFetching}
        />
      )}
    </OverlayShell>
  )

  function drillIntoFolder(path: string) {
    startTransition(() => setFolderPath(path))
    const probe = folderProbe.data as FolderBrowseData | undefined
    setQuery(pathInputForAbsolutePath(path, query, { home: probe?.home, defaultPath: probe?.defaultPath }))
  }
}

function renderFileSystemResult(result: UniversalMenuResult, state: UniversalMenuRenderState): ReactNode {
  const detail = result.actionHint ? (state.active ? result.actionHint : undefined) : result.detail
  const detailNode = result.actionHint ? undefined : result.detailNode
  const depth = result.depth ?? 0
  const isCreateFolder = result.id.startsWith('open-folder-create:')
  return (
    <div className="relative">
      <button
        type="button"
        disabled={state.disabled}
        onMouseEnter={state.onMouseEnter}
        onClick={(event) => state.onSelect(event)}
        className={`${rowClassName(state)} !gap-1.5 ${isCreateFolder ? '!text-neutral-500' : ''}`}
        style={{ paddingLeft: `${16 + depth * 12}px` }}
      >
        {result.kind === 'folder' ? (
          <span
            role={result.drill ? 'button' : undefined}
            aria-label={result.drill ? `Open ${result.label}` : undefined}
            className={`relative z-10 flex w-3 shrink-0 items-center justify-center text-neutral-600 ${result.drill ? 'cursor-pointer hover:text-neutral-300' : ''}`}
            onClick={(event) => {
              if (!result.drill) return
              event.preventDefault()
              event.stopPropagation()
              result.drill()
            }}
          >
            {depth === 0 ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
          </span>
        ) : isCreateFolder ? (
          <span className="relative z-10 flex w-3 shrink-0 items-center justify-center text-neutral-600"><Plus className="h-3.5 w-3.5" aria-hidden="true" /></span>
        ) : result.icon ? (
          <span className="relative z-10"><TabIconView icon={result.icon} /></span>
        ) : (
          <span className="relative z-10 w-3" />
        )}
        <span className={`min-w-0 flex-1 text-left ${result.labelNode ? '' : 'truncate'}`}>{result.labelNode ?? result.label}</span>
        {detail && (
          <span className="hidden max-w-[44%] truncate text-[11px] text-neutral-500 sm:block">{detail}</span>
        )}
      </button>
    </div>
  )
}

function renderWorkTreeResult(result: UniversalMenuResult, state: UniversalMenuRenderState): ReactNode {
  const depth = result.depth ?? 0
  if (result.disabled && result.alternateRun) {
    return (
      <div
        className={`${rowClassName(state)} justify-between`}
        style={{ paddingLeft: `${16 + depth * 18}px` }}
      >
        <span className="flex w-3 shrink-0 items-center justify-center text-neutral-600"><ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /></span>
        <span className={`min-w-0 flex-1 text-left ${result.labelNode ? '' : 'truncate'}`}>{result.labelNode ?? result.label}</span>
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
  actionMenuIndex,
  onOpenActions,
  onRunAction,
  loadingFolders,
  emptyText = 'No workspace resources are open yet.',
  onSelect,
}: {
  sections: Array<{ id: string; label: string; results: UniversalMenuResult[] }>
  activeIndex: number
  mouseMoved: boolean
  onMouseMoved: () => void
  onActiveChange: (index: number) => void
  actionMenuIndex?: number | null
  onOpenActions?: (index: number) => void
  onRunAction?: (action: UniversalMenuResultAction) => void
  loadingFolders: boolean
  emptyText?: string
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
                    actionMenuOpen: actionMenuIndex === index,
                    onOpenActions: () => onOpenActions?.(index),
                    onRunAction: (action) => onRunAction?.(action),
                  }}
                />
              </li>
              )
            })}
          </ul>
        </section>
      ))}
      {!hasRows && <UniversalMenuEmptyRow>{loadingFolders ? 'Loading…' : emptyText}</UniversalMenuEmptyRow>}
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
  actionMenuIndex = null,
  onOpenActions,
  onRunAction,
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
  actionMenuIndex?: number | null
  onOpenActions?: (index: number) => void
  onRunAction?: (action: UniversalMenuResultAction) => void
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
          actionMenuOpen: actionMenuIndex === index,
          onOpenActions: () => onOpenActions?.(index),
          onRunAction: (action) => onRunAction?.(action),
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
  const rowRef = useRef<HTMLDivElement | null>(null)
  const detail = result.actionHint ? (state.active ? result.actionHint : undefined) : result.detail
  const detailNode = result.actionHint ? undefined : result.detailNode
  const showActions = state.active && !!result.actions?.length
  return (
    <div ref={rowRef} onMouseEnter={state.onMouseEnter} className="relative">
      <button
        type="button"
        disabled={state.disabled}
        onClick={(event) => state.onSelect(event)}
        className={`${rowClassName(state)} ${showActions ? 'pr-10' : ''}`}
      >
        {result.icon && <TabIconView icon={result.icon} />}
        <span className={`min-w-0 flex-1 text-left ${result.labelNode ? '' : 'truncate'}`}>{result.labelNode ?? result.label}</span>
        {detailNode ? <span className="hidden max-w-[48%] truncate text-[11px] text-neutral-500 sm:block">{detailNode}</span> : detail && <span className="hidden max-w-[48%] truncate text-[11px] text-neutral-500 sm:block">{detail}</span>}
        {result.kind === 'browser-tab' && <UniversalMenuBrowserTabMarker />}
      </button>
      {showActions && (
        <button
          type="button"
          aria-label={`Actions for ${result.label}`}
          onClick={(event) => {
            event.stopPropagation()
            state.onOpenActions()
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100"
        >
          <EllipsisVertical className="h-4 w-4" aria-hidden="true" />
        </button>
      )}
      {state.actionMenuOpen && result.actions?.length ? <UniversalMenuActionMenu anchorRef={rowRef} actions={result.actions} onRunAction={state.onRunAction} /> : null}
    </div>
  )
}

function UniversalMenuActionMenu({ anchorRef, actions, onRunAction }: { anchorRef: RefObject<HTMLElement | null>; actions: UniversalMenuResultAction[]; onRunAction: (action: UniversalMenuResultAction) => void }) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    function updatePosition() {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      setPosition({ left: Math.max(8, rect.right - 184), top: rect.bottom + 4 })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [anchorRef])

  if (!position || typeof document === 'undefined') return null

  return createPortal(
    <div className="fixed z-[70] w-44 rounded border border-neutral-800 bg-neutral-975 p-1 shadow-lg" style={position} role="menu">
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          role="menuitem"
          onClick={(event) => {
            event.stopPropagation()
            onRunAction(action)
          }}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-900"
        >
          <span className="rounded bg-neutral-900 px-1 font-mono text-[10px] uppercase text-neutral-400">{action.key}</span>
          <span>{action.label}</span>
        </button>
      ))}
    </div>,
    document.body,
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
      {result.icon && <TabIconView icon={result.icon} />}
      <span className={`min-w-0 flex-1 text-left ${result.labelNode ? '' : 'truncate'}`}>{result.labelNode ?? result.label}</span>
      {detailNode ? <span className="hidden max-w-[44%] truncate text-[11px] text-neutral-500 sm:block">{detailNode}</span> : detail && <span className="hidden max-w-[44%] truncate text-[11px] text-neutral-500 sm:block">{detail}</span>}
      {result.kind === 'browser-tab' && <UniversalMenuBrowserTabMarker />}
    </button>
  )
}

function UniversalMenuBrowserTabMarker() {
  return (
    <span
      aria-hidden="true"
      data-testid="universal-menu-browser-tab-marker"
      className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border border-neutral-700 text-neutral-500"
    >
      <span className="h-2.5 w-2.5 rounded-[2px] border border-current border-t-2" />
    </span>
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

function openFolderScopeResults({
  data,
  error,
  loading,
  filter,
  workspaceId,
  startChat,
  openFile,
  drillFolder,
  createFolder,
  openNewWorkspaceChat,
}: {
  data?: FolderBrowseData
  error: unknown
  loading: boolean
  filter: string
  workspaceId?: string
  startChat: (path: string) => Promise<void>
  openFile: (path: string) => void
  drillFolder: (path: string) => void
  createFolder: (parentPath: string, name: string) => Promise<void>
  openNewWorkspaceChat: (path: string) => void
}): UniversalMenuResult[] {
  if (loading) return [disabledRow('open-folder-loading', 'Loading folders…')]
  if (error) return [disabledRow('open-folder-error', extractTrpcMessage(error))]
  if (!data) return [disabledRow('open-folder-empty', 'No folder data.')]

  const q = filter.trim().toLowerCase()
  const dirs = q ? data.dirs.filter((dir) => dir.name.toLowerCase().includes(q) || dir.path.toLowerCase().includes(q)) : data.dirs
  const files = q ? (data.files ?? []).filter((file) => file.name.toLowerCase().includes(q) || file.path.toLowerCase().includes(q)) : (data.files ?? [])
  const rows: UniversalMenuResult[] = [
    {
      id: `open-folder-current:${data.path}`,
      kind: 'folder',
      label: basename(data.path),
      detail: data.path,
      actionHint: 'create chat',
      icon: paneTabIconForType('file'),
      depth: 0,
      haystack: data.path,
      disabled: !workspaceId,
      run: () => startChat(data.path),
      alternateRun: () => openNewWorkspaceChat(data.path),
    },
  ]

  rows.push(...dirs.map((dir): UniversalMenuResult => ({
    id: `open-folder-dir:${dir.path}`,
    kind: 'folder',
    label: dir.name,
    detail: dir.path,
    actionHint: 'create chat',
    icon: paneTabIconForType('file'),
    parentId: `open-folder-current:${data.path}`,
    depth: 1,
    haystack: `${dir.name} ${dir.path}`,
    run: () => startChat(dir.path),
    alternateRun: () => openNewWorkspaceChat(dir.path),
    drill: () => drillFolder(dir.path),
  })))

  rows.push(...files.map((file): UniversalMenuResult => ({
    id: `open-folder-file:${file.path}`,
    kind: 'file',
    label: file.name,
    detail: file.path,
    actionHint: 'open file',
    icon: paneTabIconForType('file'),
    parentId: `open-folder-current:${data.path}`,
    depth: 1,
    haystack: `${file.name} ${file.path}`,
    run: () => openFile(file.path),
  })))

  const createName = folderNameToCreate(filter, data.dirs)
  if (createName) {
    rows.push({
      id: `open-folder-create:${data.path}/${createName}`,
      kind: 'action',
      label: `Create folder: ${createName}`,
      detail: data.path,
      actionHint: 'create folder',
      parentId: `open-folder-current:${data.path}`,
      depth: 1,
      haystack: `create folder ${createName} ${data.path}`,
      keepOpen: true,
      run: () => createFolder(data.path, createName),
    })
  }
  if (dirs.length === 0 && files.length === 0 && !createName) rows.push(disabledRow('open-folder-no-matches', q ? 'No matching items.' : 'No items.'))
  return rows
}

function folderNameToCreate(filter: string, dirs: FolderBrowseDir[]): string | null {
  const name = filter.trim()
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return null
  const lower = name.toLowerCase()
  if (dirs.some((dir) => dir.name.toLowerCase() === lower)) return null
  return name
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
  const configByLabel = new Map<string, RepoConfigRow | null>()
  for (const config of configs ?? []) {
    const label = config.githubFullName ?? config.name
    if (!q || `${config.name} ${config.githubFullName ?? ''} ${config.originUrl ?? ''}`.toLowerCase().includes(q) || flat.some((worktree) => (worktree.githubFullName ?? worktree.name) === label)) {
      configByLabel.set(label, config)
    }
  }
  for (const worktree of flat) {
    const label = worktree.githubFullName ?? worktree.name
    if (!configByLabel.has(label)) configByLabel.set(label, null)
  }
  const rows: UniversalMenuResult[] = []
  for (const [repoLabel, config] of configByLabel) {
    const groupId = `worktree-repo:${repoLabel}`
    rows.push({
      ...groupRow(groupId, repoLabel, 0, config?.originUrl ?? undefined),
      alternateRun: config ? () => openNewWorkspaceChat({ type: 'repoConfig', configId: config.id, worktreeName: '' }) : undefined,
    })
    for (const worktree of flat.filter((item) => (item.githubFullName ?? item.name) === repoLabel)) {
    rows.push({
      id: `worktree:${worktree.id}`,
      kind: 'worktree',
      label: worktree.worktreeName,
      detailNode: <CompactPath path={displayPath(worktree.workingDir, homePath)} />,
      parentId: groupId,
      depth: 1,
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

function shellScopeResults({ shells, loading, error, query, homePath, openShell, terminateShell }: { shells?: ShellRow[]; loading: boolean; error: unknown; query: string; homePath?: string; openShell: (shellId: string) => void; terminateShell: (shellId: string) => void | Promise<void> }): UniversalMenuResult[] {
  if (loading) return [disabledRow('shells-loading', 'Loading shells…')]
  if (error) return [disabledRow('shells-error', extractTrpcMessage(error))]
  const q = query.trim().toLowerCase()
  const rows = (shells ?? [])
    .filter((shell) => shell.alive !== false)
    .filter((shell) => !q || `${shell.title ?? ''} ${shell.id} ${shell.cwd} ${shell.ownerKind ?? ''}`.toLowerCase().includes(q))
    .map((shell): UniversalMenuResult => ({
      id: `shell:${shell.id}`,
      kind: 'shell',
      label: shell.title || `shell ${shell.id.slice(-6)}`,
      detailNode: <CompactPath path={displayPath(shell.cwd, homePath)} />,
      icon: paneTabIconForType('shell'),
      haystack: `${shell.title ?? ''} ${shell.id} ${shell.cwd}`,
      run: () => openShell(shell.id),
      actions: [{ id: 'terminate', label: 'Terminate shell', key: 't', run: () => terminateShell(shell.id) }],
    }))
  return rows.length ? rows : [disabledRow('shells-empty', q ? 'No matching shells.' : 'No shells in this workspace.')]
}

function normalSearchResults({
  bookmarks,
  commandResults,
  faviconRecords,
  query,
  openContent,
}: {
  bookmarks: BookmarkRecord[]
  commandResults: UniversalMenuResult[]
  faviconRecords: FaviconCacheByOrigin
  query: string
  openContent: (content: PaneContent) => void
}): UniversalMenuResult[] {
  const trimmed = query.trim()
  const lower = trimmed.toLowerCase()
  const rows: UniversalMenuResult[] = []
  const directDecision = resolveBrowserAddress(trimmed)

  if (directDecision.kind === 'url') {
    const directUrl = directDecision.url.replace(/\/$/, '')
    rows.push({
      id: `normal-url:${directUrl}`,
      kind: 'browser-tab',
      label: directUrl.replace(/^https?:\/\//, ''),
      detail: directUrl,
      icon: browserTabIconForUrl({ url: directUrl, records: faviconRecords }),
      haystack: directUrl,
      run: () => openContent({ type: 'browser', url: directUrl }),
    })
  }

  rows.push(...matchBookmarks(bookmarks, query).map((match): UniversalMenuResult => ({
    id: `normal-bookmark:${match.bookmark.id}`,
    kind: 'bookmark',
    label: match.bookmark.title,
    detail: match.bookmark.origin?.replace(/^https?:\/\//, '') ?? match.bookmark.url,
    icon: bookmarkIcon(match.bookmark, faviconRecords),
    haystack: `${match.bookmark.title} ${match.bookmark.url} ${match.bookmark.origin ?? ''}`,
    run: () => openContent({ type: 'browser', url: match.bookmark.url }),
  })))

  rows.push(...commandResults
    .map((result) => ({ result, score: fuzzyScore(result.haystack.toLowerCase(), lower) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.result))

  if (trimmed) {
    const searchUrl = buildWebSearchUrl(trimmed)
    rows.push({
      id: `normal-web-search:${trimmed}`,
      kind: 'browser-tab',
      label: `Web search "${trimmed}"`,
      detail: searchUrl,
      icon: paneTabIconForType('browser'),
      haystack: trimmed,
      run: () => openContent({ type: 'browser', url: searchUrl }),
    })
  }

  return rows
}

function webScopeResults({
  items,
  bookmarks,
  query,
  faviconRecords,
  openContent,
}: {
  items: UniversalMenuContextItem[]
  bookmarks: BookmarkRecord[]
  query: string
  faviconRecords: FaviconCacheByOrigin
  openContent: (content: PaneContent) => void
}): UniversalMenuResult[] {
  const q = query.trim().toLowerCase()
  const directDecision = query.trim() ? resolveBrowserAddress(query) : { kind: 'url' as const, url: '' }
  const rows: UniversalMenuResult[] = []
  if (directDecision.kind === 'url' && directDecision.url) {
    const directUrl = directDecision.url.replace(/\/$/, '')
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
      icon: item.content.type === 'browser' ? browserTabIconForUrl({ url: item.content.url, faviconUrl: item.content.faviconUrl, records: faviconRecords }) : paneTabIconForType('browser'),
      haystack: `${item.label} ${item.detail ?? ''}`,
      run: () => openContent(item.content),
    })))
  rows.push(...matchBookmarks(bookmarks, query).map((match): UniversalMenuResult => ({
    id: `web-bookmark:${match.bookmark.id}`,
    kind: 'bookmark',
    label: match.bookmark.title,
    detail: match.bookmark.origin?.replace(/^https?:\/\//, '') ?? match.bookmark.url,
    icon: bookmarkIcon(match.bookmark, faviconRecords),
    haystack: `${match.bookmark.title} ${match.bookmark.url} ${match.bookmark.origin ?? ''}`,
    run: () => openContent({ type: 'browser', url: match.bookmark.url }),
  })))
  if (directDecision.kind === 'search') {
    rows.push({
      id: `web-search:${directDecision.query}`,
      kind: 'browser-tab',
      label: `Search web for "${directDecision.query}"`,
      detail: directDecision.url,
      icon: paneTabIconForType('browser'),
      haystack: directDecision.query,
      run: () => openContent({ type: 'browser', url: directDecision.url }),
    })
  }
  return rows.length ? rows : [disabledRow('web-empty', q ? 'No matching pages or bookmarks.' : 'No browser pages or bookmarks.')]
}

function bookmarkIcon(bookmark: BookmarkRecord, faviconRecords: FaviconCacheByOrigin): TabIcon {
  const iconUrl = bookmark.faviconDataUrl ?? bookmark.faviconUrl
  if (iconUrl) return { kind: 'favicon', url: iconUrl, fallback: { kind: 'pane', pane: 'browser' } }
  return browserTabIconForUrl({ url: bookmark.url, records: faviconRecords })
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
  const groups = new Set<string>()
  for (const file of files ?? []) {
    const groupId = `file-root:${file.root}`
    if (!groups.has(groupId)) {
      groups.add(groupId)
      rows.push(groupRow(groupId, basename(file.root), 0, displayPath(file.root, homePath)))
    }
    rows.push({
      id: `file:${file.path}`,
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

function timestampMs(value: string | Date | undefined): number {
  if (!value) return 0
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

function isPathLikeInput(value: string): boolean {
  const trimmed = value.trimStart()
  return trimmed.startsWith('~') || trimmed.includes('/')
}

function pathBrowsePlan(value: string, anchors: { home?: string | null; defaultPath?: string | null }): FolderBrowsePlan {
  const trimmed = value.trim()
  const home = anchors.home || undefined
  const defaultPath = anchors.defaultPath || undefined

  let expanded: string
  if (!trimmed) return { dir: undefined, filter: '' }
  if (trimmed === '~') return { dir: home, filter: '' }
  if (trimmed.startsWith('~/')) {
    expanded = home ? `${home}${trimmed.slice(1)}` : trimmed
  } else if (trimmed.startsWith('/')) {
    expanded = trimmed
  } else {
    const relativeRoot = home ?? defaultPath
    expanded = relativeRoot ? `${relativeRoot.replace(/\/+$/, '')}/${trimmed}` : trimmed
  }

  if (expanded.endsWith('/')) return { dir: expanded, filter: '' }
  const slash = expanded.lastIndexOf('/')
  if (slash < 0) return { dir: defaultPath, filter: expanded }
  if (slash === 0) return { dir: '/', filter: expanded.slice(1) }
  return { dir: expanded.slice(0, slash), filter: expanded.slice(slash + 1) }
}

function pathInputForAbsolutePath(path: string, currentInput: string, anchors: { home?: string | null; defaultPath?: string | null }): string {
  const normalized = path.replace(/\/+$/, '')
  const trimmed = currentInput.trimStart()
  if (trimmed.startsWith('/')) return `${normalized}/`

  const home = anchors.home?.replace(/\/+$/, '')
  if (trimmed.startsWith('~') && home && isPathWithin(normalized, home)) {
    const rel = normalized === home ? '' : normalized.slice(home.length + 1)
    return rel ? `~/${rel}/` : '~/'
  }

  if (home && isPathWithin(normalized, home)) {
    const rel = normalized === home ? '' : normalized.slice(home.length + 1)
    return rel ? `${rel}/` : ''
  }

  const defaultPath = anchors.defaultPath?.replace(/\/+$/, '')
  if (defaultPath && isPathWithin(normalized, defaultPath)) {
    const rel = normalized === defaultPath ? '' : normalized.slice(defaultPath.length + 1)
    return rel ? `${rel}/` : ''
  }

  return `${normalized}/`
}

function isPathWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

function parentPath(path: string | undefined): string | null {
  if (!path) return null
  const normalized = path.replace(/\/+$/, '')
  const slash = normalized.lastIndexOf('/')
  if (slash < 0) return null
  if (slash === 0) return '/'
  return normalized.slice(0, slash)
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
