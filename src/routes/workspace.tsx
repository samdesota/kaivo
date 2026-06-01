import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronLeft, ChevronRight, Plus, Settings, X } from 'lucide-react'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  defaultAnimateLayoutChanges,
  SortableContext,
  sortableKeyboardCoordinates,
  type SortingStrategy,
  useSortable,
  verticalListSortingStrategy,
  type AnimateLayoutChanges,
} from '@dnd-kit/sortable'
import { CSS as DndCss } from '@dnd-kit/utilities'
import { trpc } from '../trpc'
import { envTrpc, makeManagedEnvReactClient } from '../env-trpc'
import { useAppData } from '../data/app-data-provider'
import { archiveWorkspace, markWorkspaceOpened, renameWorkspace, useVisibleWorkspaces, useWorkspace } from '../data/modules/workspaces'
import { createWorkspaceFolder, moveWorkspaceSidebarNode, renameWorkspaceFolder, setWorkspaceFolderCollapsed, useWorkspaceSidebarTree } from '../data/modules/workspace-folders'
import { setActiveAgentSession, setActiveWorkspaceTab, setAgentCollapsed as setAgentCollapsedCommand, setWorkspaceSplitRatio, useWorkspaceSearchSync, useWorkspaceViewState } from '../data/modules/workspace-view-state'
import { closeWorkspaceTab as closeWorkspaceTabCommand, openWorkspaceTab, openWorkspaceTabLocal, replaceWorkspaceTab, reorderWorkspaceTabs, setWorkspaceTabBrowserId, setWorkspaceTabTitle, setWorkspaceTabUrl, useWorkspaceTabs } from '../data/modules/workspace-tabs'
import type { WorkspaceFolderRecord, WorkspaceSidebarNode } from '../data/modules/workspace-folders'
import type { WorkspaceRecord } from '../data/modules/workspaces'
import { browserApi } from '../lib/browser-api'
import { resolveBrowserAddress } from '../lib/browser-navigation'
import { browserTabIconForUrl, faviconOriginForUrl, type FaviconCacheRecord } from '../lib/favicon-cache'
import { openTextInputOverlay, openUniversalMenuOverlay, openWorkspaceCleanupOverlay, prewarmOverlayLayer } from '../lib/overlay-layer-controller'
import { extractTrpcMessage } from '../lib/utils'
import { BorderedTabStrip, type BorderedTabItem } from '../components/bordered-tab-strip'
import { paneTabIconForType, TabIconView } from '../components/tab-icon'
import { ShellChrome } from './env/shell/shell-chrome'
import { EnvContextProvider } from './env/env-context'
import { AgentSessionView } from './env/agent/session-view'
import { NewSessionPopover } from './env/agent/session-tabs'
import type { UniversalMenuChatBootstrap, UniversalMenuContextItem, UniversalMenuInitialIntent, UniversalMenuWorkspaceBootstrap, UniversalMenuWorkspaceBootstrapRequest } from './env/universal-menu/universal-menu'
import { emptyFileEditorState, type FileEditorState } from './env/file-editor-state'
import { ShellTabContent } from './env/tabs/shell-tab'
import { FileTabContent } from './env/tabs/file-tab'
import { BrowserTabContent } from './env/tabs/browser-tab'
import type { PaneContent } from './env/shell/tab-state'
import {
  createWorkspaceEnvClientResolver,
  unavailableReasonForWorkspaceTab,
  resolveWorkspaceEnvTarget,
  selectLocalEnvTarget,
  type WorkspaceEnvTarget,
  type WorkspaceEnvRow,
} from './workspace/env-targets'
import { WorkspaceContextProvider, useWorkspaceContext } from './workspace/context'
import { closeNativeBrowserTabsForWorkspace } from './workspace/browser-tab-cleanup'
import {
  type WorkspaceTab,
  type WorkspaceUiAction,
  type WorkspaceUiState,
  updateFileEditorStateForTab,
} from './workspace/tab-state'
import { useWorkspaceResourcesStore, type WorkspaceResourceRecord } from './workspace/resources-store'
import { useBookmarksStore } from './workspace/bookmarks-store'
import { idleRenameEditState, nextRenameValue, renameEditReducer } from './workspace/tab-bar-state'
import { makeWorkspaceTabId, workspaceTabFromPaneContent } from './workspace/open-pane'
import { workspaceRollupGlyph, workspaceRollupState } from './workspace/sidebar-rollup-state'
import { useAgentNotificationsStore, type AgentNotificationRecord } from './workspace/notifications-store'
import { useAgentRuntimeStore } from './workspace/agent-runtime-store'
import {
  projectSidebarDropFromRows,
  flattenSidebarTree,
  moveSidebarNodeInTree,
  parseSidebarDndId,
  setSidebarFolderCollapsedInTree,
  sidebarDndId,
  type DropPlacement,
  type FlatSidebarNode,
  type SidebarTreeNode,
  type SidebarDropProjection,
} from './workspace/sidebar-dnd-state'
import { trpcQueryKey } from '../lib/trpc-plain'
import { playAgentNotificationSound, readAgentNotificationSoundPrefs, readLastAgentRunDurationMs, useAgentNotificationSoundPrefs } from '../lib/agent-notification-sounds'
import { clientLogger } from '../lib/client-logger'

type WorkspaceUiDispatch = (action: WorkspaceUiAction) => void

type GlobalTabsWorkspaceSummary = {
  id: string
  name: string
}

type GlobalTabDestination = {
  workspace: GlobalTabsWorkspaceSummary | null
  tabs: WorkspaceTab[]
  activeTabId: string | null
}

type WorkspaceSummary = WorkspaceRecord

const WORKSPACE_SIDEBAR_WIDTH_KEY = 'kaivo.workspaceSidebarWidth'
const LEGACY_WORKSPACE_SIDEBAR_WIDTH_KEY = 'cloud-code.workspaceSidebarWidth'
const WORKSPACE_SIDEBAR_MIN_WIDTH = 208
const WORKSPACE_SIDEBAR_MAX_WIDTH = 420
const WORKSPACE_CHAT_READ_KEY = 'kaivo.workspaceChatReadAt'
const LEGACY_WORKSPACE_CHAT_READ_KEY = 'cloud-code.workspaceChatReadAt'
const WORKSPACE_BOOTSTRAP_EVENT = 'kaivo.workspaceBootstrapChanged'
const PENDING_SHELL_ID_PREFIX = '__pending-shell:'
const workspaceLog = clientLogger.diagnostic('workspace')

type EnvShellCreateClient = {
  shell: {
    create: {
      mutate(input: { workspaceId?: string; cwd?: string }): Promise<{ id: string }>
    }
  }
}

type EnvChatBootstrapClient = {
  agent: {
    sessionStart: {
      mutate(input: { workspaceId?: string; directory?: string }): Promise<{ id: string }>
    }
  }
  repo: {
    cloneConfig: {
      mutate(input: { configId: string; worktreeName: string }): Promise<{ repoId: string; workingDir: string }>
    }
  }
}

type WorkspaceBootstrapStatus = {
  message: string
  error?: boolean
}

const pendingWorkspaceBootstraps = new Map<string, UniversalMenuWorkspaceBootstrap>()
const runningWorkspaceBootstraps = new Set<string>()
const workspaceBootstrapStatuses = new Map<string, WorkspaceBootstrapStatus>()

export function enqueueWorkspaceBootstrap(bootstrap: UniversalMenuWorkspaceBootstrap) {
  console.info('[workspace-bootstrap] enqueue', { workspaceId: bootstrap.workspaceId, type: bootstrap.type })
  pendingWorkspaceBootstraps.set(bootstrap.workspaceId, bootstrap)
  setWorkspaceBootstrapStatus(bootstrap.workspaceId, {
    message: bootstrap.type === 'repoConfig' ? 'Cloning worktree…' : 'Creating chat…',
  })
}

export function workspaceBootstrapWithId(request: UniversalMenuWorkspaceBootstrapRequest, workspaceId: string): UniversalMenuWorkspaceBootstrap {
  if (request.bootstrap.type === 'folder') return { ...request.bootstrap, workspaceId }
  if (request.bootstrap.type === 'worktree') return { ...request.bootstrap, workspaceId }
  return { ...request.bootstrap, workspaceId }
}

function takeWorkspaceBootstrap(workspaceId: string): UniversalMenuWorkspaceBootstrap | null {
  if (runningWorkspaceBootstraps.has(workspaceId)) {
    console.info('[workspace-bootstrap] take skipped already running', { workspaceId })
    return null
  }
  const bootstrap = pendingWorkspaceBootstraps.get(workspaceId)
  if (!bootstrap) return null
  console.info('[workspace-bootstrap] take', { workspaceId, type: bootstrap.type })
  pendingWorkspaceBootstraps.delete(workspaceId)
  runningWorkspaceBootstraps.add(workspaceId)
  return bootstrap
}

function finishWorkspaceBootstrap(workspaceId: string) {
  console.info('[workspace-bootstrap] finish', { workspaceId })
  runningWorkspaceBootstraps.delete(workspaceId)
  workspaceBootstrapStatuses.delete(workspaceId)
  dispatchWorkspaceBootstrapChanged()
}

function failWorkspaceBootstrap(workspaceId: string, message: string) {
  console.error('[workspace-bootstrap] fail', { workspaceId, message })
  runningWorkspaceBootstraps.delete(workspaceId)
  setWorkspaceBootstrapStatus(workspaceId, { message, error: true })
}

function setWorkspaceBootstrapStatus(workspaceId: string, status: WorkspaceBootstrapStatus) {
  workspaceBootstrapStatuses.set(workspaceId, status)
  dispatchWorkspaceBootstrapChanged()
}

function useWorkspaceBootstrapStatus(workspaceId: string): WorkspaceBootstrapStatus | null {
  const [status, setStatus] = useState(() => workspaceBootstrapStatuses.get(workspaceId) ?? null)
  useEffect(() => {
    function update() {
      setStatus(workspaceBootstrapStatuses.get(workspaceId) ?? null)
    }
    window.addEventListener(WORKSPACE_BOOTSTRAP_EVENT, update)
    update()
    return () => window.removeEventListener(WORKSPACE_BOOTSTRAP_EVENT, update)
  }, [workspaceId])
  return status
}

function dispatchWorkspaceBootstrapChanged() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(WORKSPACE_BOOTSTRAP_EVENT))
}

function pendingShellId(tabId: string): string {
  return `${PENDING_SHELL_ID_PREFIX}${tabId}`
}

function isPendingShellTab(tab: WorkspaceTab): boolean {
  return tab.type === 'shell' && tab.shellId.startsWith(PENDING_SHELL_ID_PREFIX)
}

type WorkspaceEnvResources = {
  queryClient: QueryClient
  managedClient: ReturnType<typeof makeManagedEnvReactClient>
}

const workspaceEnvResources = new Map<string, WorkspaceEnvResources>()

function getWorkspaceEnvResources(target: WorkspaceEnvTarget): WorkspaceEnvResources | null {
  if (!target.token) return null
  const key = `${target.env.id}:${target.env.url}:${target.token}`
  let resources = workspaceEnvResources.get(key)
  if (!resources) {
    resources = {
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
      managedClient: makeManagedEnvReactClient(target.env, target.token),
    }
    workspaceEnvResources.set(key, resources)
  }
  return resources
}

export function WorkspacePage() {
  const { workspaceId } = useParams({ from: '/w/$workspaceId' })
  const search = useSearch({ from: '/w/$workspaceId' })

  return <WorkspaceRoutePage workspaceId={workspaceId} search={search} syncWorkspaceSearch globalTabsMode={false} globalTabsActiveTabId={null} />
}

export function GlobalTabsPage() {
  const search = useSearch({ from: '/tabs' })
  const appData = useAppData()
  const workspaces = useVisibleWorkspaces()
  const workspaceId = workspaces[0]?.id ?? null

  if (!appData.ready && !workspaceId) return <div className="p-8 text-neutral-500">Loading tabs…</div>
  if (appData.error && !workspaceId) return <WorkspaceError message={extractTrpcMessage(appData.error)} />
  if (!workspaceId) return <WorkspaceError message="No workspace available for global tabs." />

  return (
    <WorkspaceRoutePage
      workspaceId={workspaceId}
      search={{ chat: undefined, tab: undefined }}
      syncWorkspaceSearch={false}
      globalTabsMode
      globalTabsActiveTabId={search.tab ?? null}
    />
  )
}

function WorkspaceRoutePage({
  workspaceId,
  search,
  syncWorkspaceSearch,
  globalTabsMode,
  globalTabsActiveTabId,
}: {
  workspaceId: string
  search: { chat?: string; tab?: string }
  syncWorkspaceSearch: boolean
  globalTabsMode: boolean
  globalTabsActiveTabId: string | null
}) {
  const navigate = useNavigate()
  const appData = useAppData()
  const workspace = useWorkspace(workspaceId)
  const envs = trpc.env.list.useQuery({}, { refetchInterval: 10_000 })
  const upsertResource = trpc.workspace.upsertResource.useMutation()
  const viewState = useWorkspaceViewState(workspaceId)
  const workspaceTabs = useWorkspaceTabs(workspaceId)
  const lastReadyWorkspaceRef = useRef<ReactNode | null>(null)

  useEffect(() => {
    if (workspace?.id) void markWorkspaceOpened(workspace.id).catch((error) => console.warn('mark workspace opened failed', error))
  }, [workspace?.id])

  useWorkspaceSearchSync({
    workspaceId,
    search,
    viewState,
    tabs: workspaceTabs,
    enabled: syncWorkspaceSearch && workspace?.id === workspaceId,
    replaceSearch: useCallback((nextSearch) => {
      void navigate({
        to: '/w/$workspaceId',
        params: { workspaceId },
        search: (prev) => ({
          ...prev,
          chat: nextSearch.chat,
          tab: nextSearch.tab,
        }),
        replace: true,
      })
    }, [navigate, workspaceId]),
  })

  const dispatchSyncedWorkspaceState = useCallback<WorkspaceUiDispatch>((action) => {
    if (action.type === 'setActiveAgentSession') {
      void setActiveAgentSession({ workspaceId, sessionId: action.sessionId })
    } else if (action.type === 'activateTab') {
      void setActiveWorkspaceTab({ workspaceId, tabId: action.tabId })
    } else if (action.type === 'openTab' && action.activate !== false) {
      void openWorkspaceTab({ workspaceId, tab: action.tab, activate: true })
    } else if (action.type === 'openTab') {
      void openWorkspaceTab({ workspaceId, tab: action.tab, activate: false })
    } else if (action.type === 'closeTab') {
      void closeWorkspaceTabCommand({ workspaceId, tabId: action.tabId })
    } else if (action.type === 'reorderTabs') {
      void reorderWorkspaceTabs({ workspaceId, tabIds: action.tabIds })
    } else if (action.type === 'setBrowserTabId') {
      void setWorkspaceTabBrowserId({ workspaceId, tabId: action.tabId, browserTabId: action.browserTabId })
      const tab = workspaceTabs.find((candidate) => candidate.id === action.tabId)
      if (tab?.type === 'browser') {
        upsertResource.mutate({
          workspaceId,
          resource: {
            type: 'browser_tab',
            resourceKey: action.browserTabId,
            shared: false,
            data: { browserTabId: action.browserTabId, tabId: action.tabId, url: tab.url, title: tab.title },
          },
        })
      }
    } else if (action.type === 'setTabUrl') {
      void setWorkspaceTabUrl({ workspaceId, tabId: action.tabId, url: action.url })
    } else if (action.type === 'setTabTitle') {
      void setWorkspaceTabTitle({ workspaceId, tabId: action.tabId, title: action.title, source: 'explicit' })
    } else if (action.type === 'setTabAutoTitle') {
      void setWorkspaceTabTitle({ workspaceId, tabId: action.tabId, title: action.title, source: 'auto' })
    } else if (action.type === 'setSplitRatio') {
      void setWorkspaceSplitRatio({ workspaceId, splitRatio: action.splitRatio })
    } else if (action.type === 'setAgentCollapsed') {
      void setAgentCollapsedCommand({ workspaceId, collapsed: action.collapsed })
    }
  }, [upsertResource, workspaceId, workspaceTabs])

  const envTargets = useMemo(() => {
    return ((envs.data ?? []) as WorkspaceEnvRow[]).map(resolveWorkspaceEnvTarget)
  }, [envs.data])
  const localEnvTarget = useMemo(() => selectLocalEnvTarget(envTargets), [envTargets])
  const getEnvClient = useMemo(
    () => createWorkspaceEnvClientResolver(envTargets),
    [envTargets],
  )

  const initiallyLoading = !appData.ready && !workspace

  if (initiallyLoading) {
    logWorkspaceLoading('initiallyLoading', workspaceId, {
      appDataReady: appData.ready,
      workspaceHasData: Boolean(workspace),
      envsLoading: envs.isLoading,
      envsHasData: Boolean(envs.data),
      workspaceTabs: workspaceTabs.length,
    })
    if (lastReadyWorkspaceRef.current) return lastReadyWorkspaceRef.current
    return <div className="p-8 text-neutral-500">Loading workspace…</div>
  }
  if (appData.error && !workspace) return <WorkspaceError message={extractTrpcMessage(appData.error)} />
  if (envs.error) return <WorkspaceError message={extractTrpcMessage(envs.error)} />
  if (!workspace) {
    return <WorkspaceError message="Workspace did not load." />
  }

  const syncedWorkspaceState: WorkspaceUiState = {
    workspaceTabs,
    activeAgentSessionId: viewState.activeAgentSessionId,
    activeWorkspaceTabId: viewState.activeWorkspaceTabId,
    splitRatio: viewState.splitRatio,
    agentCollapsed: viewState.agentCollapsed,
    tabOrder: workspaceTabs.map((tab) => tab.id),
  }

  const readyWorkspace = (
    <WorkspaceContextProvider
      value={{
        workspace,
        uiState: syncedWorkspaceState,
        envTargets,
        localEnvTarget,
        getEnvClient,
      }}
    >
      <WorkspaceShell
        dispatchWorkspaceState={dispatchSyncedWorkspaceState}
        globalTabsMode={globalTabsMode}
        globalTabsActiveTabId={globalTabsActiveTabId}
      />
    </WorkspaceContextProvider>
  )
  lastReadyWorkspaceRef.current = readyWorkspace
  return readyWorkspace
}

function logWorkspaceLoading(reason: string, workspaceId: string, state: Record<string, unknown>) {
  workspaceLog.info('loading workspace', {
    reason,
    workspaceId,
    ...state,
  })
}

function WorkspaceShell({
  dispatchWorkspaceState,
  globalTabsMode,
  globalTabsActiveTabId,
}: {
  dispatchWorkspaceState: WorkspaceUiDispatch
  globalTabsMode: boolean
  globalTabsActiveTabId: string | null
}) {
  const ctx = useWorkspaceContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const createWorkspace = trpc.workspace.create.useMutation()
  const upsertResource = trpc.workspace.upsertResource.useMutation()
  const getOrCreateGlobalTabsWorkspace = trpc.workspace.getOrCreateGlobalTabsWorkspace.useMutation()
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const [agentSessionCount, setAgentSessionCount] = useState(0)
  const [focusedTabGroup, setFocusedTabGroup] = useState<'agent' | 'workspace'>('agent')
  const [closeAgentTabSignal, setCloseAgentTabSignal] = useState(0)
  const [globalTabsWorkspace, setGlobalTabsWorkspace] = useState<GlobalTabsWorkspaceSummary | null>(null)
  const agentCollapsed = ctx.uiState.agentCollapsed
  const globalTabs = useWorkspaceTabs(globalTabsWorkspace?.id ?? '__global-tabs-pending__').filter((tab) => tab.type === 'browser')
  const activeGlobalTab = globalTabsMode
    ? (globalTabs.find((tab) => tab.id === globalTabsActiveTabId) ?? globalTabs[0] ?? null)
    : null
  const showGlobalTab = useCallback((tabId: string | null) => {
    void navigate({ to: '/tabs', search: { tab: tabId ?? undefined } })
  }, [navigate])
  const onSplitRatioChange = useCallback(
    (ratio: number) => dispatchWorkspaceState({ type: 'setSplitRatio', splitRatio: ratio }),
    [dispatchWorkspaceState],
  )
  const setAgentCollapsed = useCallback(
    (collapsed: boolean) => dispatchWorkspaceState({ type: 'setAgentCollapsed', collapsed }),
    [dispatchWorkspaceState],
  )
  const openWorkspacePane = useWorkspaceOpenPane(dispatchWorkspaceState)
  const openPane = useCallback(
    (content: PaneContent, options?: { title?: string; activate?: boolean }) => {
      openWorkspacePane(content, options)
      setFocusedTabGroup('workspace')
      if (agentSessionCount === 0) setAgentCollapsed(true)
    },
    [agentSessionCount, openWorkspacePane, setAgentCollapsed],
  )
  const closeActiveTab = useCallback(() => {
    if (activeGlobalTab && globalTabsWorkspace) {
      closeWorkspaceTab(activeGlobalTab, {
        type: 'closeTab',
        closeTab: (tabId) => void closeWorkspaceTabCommand({ workspaceId: globalTabsWorkspace.id, tabId, activateFallback: false }),
        onActiveTabClosed: () => showGlobalTab(nextGlobalTabIdAfterClose(globalTabs, activeGlobalTab.id)),
      })
      return
    }
    const activeTab = ctx.uiState.workspaceTabs.find((tab) => tab.id === ctx.uiState.activeWorkspaceTabId)
    if (activeTab) closeWorkspaceTab(activeTab, dispatchWorkspaceState)
  }, [activeGlobalTab, ctx.uiState.activeWorkspaceTabId, ctx.uiState.workspaceTabs, dispatchWorkspaceState, globalTabs, globalTabsWorkspace, showGlobalTab])

  useEffect(() => {
    let cancelled = false
    void getOrCreateGlobalTabsWorkspace.mutateAsync().then((workspace) => {
      if (!cancelled) setGlobalTabsWorkspace(workspace as GlobalTabsWorkspaceSummary)
    }).catch((error) => console.warn('global tabs workspace unavailable', error))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!globalTabsMode) return
    if (activeGlobalTab && activeGlobalTab.id !== globalTabsActiveTabId) {
      showGlobalTab(activeGlobalTab.id)
    }
  }, [activeGlobalTab, globalTabsActiveTabId, globalTabsMode, showGlobalTab])

  const bootstrapWorkspace = useCallback(async (request: UniversalMenuWorkspaceBootstrapRequest) => {
    console.info('[workspace-bootstrap] create workspace start', { type: request.bootstrap.type, name: request.workspaceCreate.name, sourceKind: request.workspaceCreate.sourceKind })
    try {
      const workspace = await createWorkspace.mutateAsync(request.workspaceCreate) as { id: string }
      console.info('[workspace-bootstrap] create workspace success', { workspaceId: workspace.id, type: request.bootstrap.type })
      enqueueWorkspaceBootstrap(workspaceBootstrapWithId(request, workspace.id))
      console.info('[workspace-bootstrap] navigate start', { workspaceId: workspace.id })
      await navigate({ to: '/w/$workspaceId', params: { workspaceId: workspace.id }, search: { chat: undefined, tab: undefined } })
      console.info('[workspace-bootstrap] navigate complete', { workspaceId: workspace.id })
    } catch (error) {
      console.error('[workspace-bootstrap] create workspace failed', error)
      throw error
    }
  }, [createWorkspace, navigate])

  const selectCreatedChat = useCallback(async (sessionId: string, workspaceId?: string) => {
    if (!workspaceId) return
    await queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList', { workspaceId }) })
    if (workspaceId === ctx.workspace.id) {
      dispatchWorkspaceState({ type: 'setActiveAgentSession', sessionId })
    }
    await navigate({
      to: '/w/$workspaceId',
      params: { workspaceId },
      search: { chat: sessionId, tab: undefined },
    })
  }, [ctx.workspace.id, dispatchWorkspaceState, navigate, queryClient])

  const createWorkspaceChat = useCallback((bootstrap: UniversalMenuChatBootstrap) => {
    const target = ctx.localEnvTarget
    if (!target?.available || !target.token) return
    setWorkspaceBootstrapStatus(bootstrap.workspaceId, {
      message: bootstrap.type === 'repoConfig' ? 'Cloning worktree…' : 'Creating chat…',
    })
    if (bootstrap.workspaceId === ctx.workspace.id) {
      dispatchWorkspaceState({ type: 'setActiveAgentSession', sessionId: null })
      setFocusedTabGroup('agent')
      if (agentCollapsed) setAgentCollapsed(false)
    }
    void (async () => {
      try {
        const client = ctx.getEnvClient(target.env.id) as unknown as EnvChatBootstrapClient
        let workingDir: string
        let repoId: string | undefined
        let resourceName: string | undefined
        if (bootstrap.type === 'repoConfig') {
          const cloned = await client.repo.cloneConfig.mutate({ configId: bootstrap.configId, worktreeName: bootstrap.worktreeName })
          workingDir = cloned.workingDir
          repoId = cloned.repoId
          resourceName = bootstrap.worktreeName
          setWorkspaceBootstrapStatus(bootstrap.workspaceId, { message: 'Linking worktree…' })
        } else if (bootstrap.type === 'worktree') {
          workingDir = bootstrap.path
          repoId = bootstrap.repoId
          resourceName = bootstrap.name
          setWorkspaceBootstrapStatus(bootstrap.workspaceId, { message: 'Linking worktree…' })
        } else {
          workingDir = bootstrap.path
        }
        if (bootstrap.type !== 'folder') {
          await upsertResource.mutateAsync({
            workspaceId: bootstrap.workspaceId,
            resource: {
              type: 'worktree',
              resourceKey: repoId ? `repo:${repoId}` : `path:${workingDir}`,
              shared: true,
              data: { repoId, workingDir, name: resourceName },
            },
          })
        }
        setWorkspaceBootstrapStatus(bootstrap.workspaceId, { message: 'Creating chat…' })
        const session = await client.agent.sessionStart.mutate({ workspaceId: bootstrap.workspaceId, directory: workingDir })
        await getWorkspaceEnvResources(target)?.queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList', { workspaceId: bootstrap.workspaceId }) })
        await selectCreatedChat(session.id, bootstrap.workspaceId)
        finishWorkspaceBootstrap(bootstrap.workspaceId)
      } catch (error) {
        failWorkspaceBootstrap(bootstrap.workspaceId, extractTrpcMessage(error))
      }
    })()
  }, [agentCollapsed, ctx, dispatchWorkspaceState, selectCreatedChat, setAgentCollapsed, upsertResource])

  const ensureGlobalTabsWorkspace = useCallback(async (): Promise<GlobalTabsWorkspaceSummary> => {
    if (globalTabsWorkspace) return globalTabsWorkspace
    const workspace = await getOrCreateGlobalTabsWorkspace.mutateAsync() as GlobalTabsWorkspaceSummary
    setGlobalTabsWorkspace(workspace)
    return workspace
  }, [getOrCreateGlobalTabsWorkspace, globalTabsWorkspace])

  const openGlobalPane = useCallback(async (content: PaneContent, options?: { title?: string }) => {
    const tab = globalTabFromPaneContent(content, options)
    if (!tab) return
    const workspace = await ensureGlobalTabsWorkspace()
    await openWorkspaceTab({ workspaceId: workspace.id, tab, activate: false })
    showGlobalTab(tab.id)
  }, [ensureGlobalTabsWorkspace, showGlobalTab])

  const openPendingShellPane = useCallback((cwd?: string) => {
    const envId = ctx.localEnvTarget?.env.id
    if (!envId) return
    const tabId = makeWorkspaceTabId('shell', envId)
    const tab: WorkspaceTab = {
      id: tabId,
      type: 'shell',
      envId,
      shellId: pendingShellId(tabId),
      title: 'Starting shell…',
      titleSource: 'explicit',
    }
    void openWorkspaceTabLocal({ workspaceId: ctx.workspace.id, tab, activate: true })
    setFocusedTabGroup('workspace')
    if (agentSessionCount === 0) setAgentCollapsed(true)
    void (async () => {
      try {
        const client = ctx.getEnvClient(envId) as unknown as EnvShellCreateClient
        const info = await client.shell.create.mutate({ workspaceId: ctx.workspace.id, ...(cwd ? { cwd } : {}) })
        await replaceWorkspaceTab({
          workspaceId: ctx.workspace.id,
          tabId,
          tab: {
            id: tabId,
            type: 'shell',
            envId,
            shellId: info.id,
            title: `shell ${info.id.slice(-8)}`,
            titleSource: 'auto',
          },
        })
      } catch (error) {
        console.warn('new shell failed', error)
        await closeWorkspaceTabCommand({ workspaceId: ctx.workspace.id, tabId }).catch(() => undefined)
      }
    })()
  }, [agentSessionCount, ctx, setAgentCollapsed])

  const openCommandPalette = useCallback(async (initialIntent: UniversalMenuInitialIntent = 'default') => {
    const target = ctx.localEnvTarget
    console.info('[universal-menu] open from workspace', { initialIntent, workspaceId: ctx.workspace.id, envAvailable: Boolean(target?.available), hasToken: Boolean(target?.token) })
    if (!target?.available || !target.token) {
      if (initialIntent === 'default') {
        const value = await openTextInputOverlay({
          title: 'New tab',
          label: 'URL or search',
          placeholder: 'example.com or search terms',
          confirmLabel: 'Open',
        })
        if (!value) return
        const content: PaneContent = { type: 'browser', url: resolveBrowserAddress(value).url }
        openPane(content)
      }
      return
    }
    const result = await openUniversalMenuOverlay({
      env: target.env,
      envToken: target.token,
      workspaceId: ctx.workspace.id,
      workspaceName: ctx.workspace.name,
      workspaceFolderId: ctx.workspace.folderId,
      activeSessionId: ctx.uiState.activeAgentSessionId,
      hasActiveTab: ctx.uiState.workspaceTabs.length > 0,
      contextItems: ctx.uiState.workspaceTabs.flatMap((tab): UniversalMenuContextItem[] => {
        if (tab.type === 'shell') {
          return [{ id: `tab:${tab.id}`, kind: 'shell', label: tab.title, detail: `shell ${tab.shellId}`, content: { type: 'shell', shellId: tab.shellId } }]
        }
        if (tab.type === 'browser') {
          return [{ id: `tab:${tab.id}`, kind: 'browser-tab', label: tab.title, detail: tab.url ?? tab.browserTabId ?? 'Browser', content: { type: 'browser', url: tab.url, browserTabId: tab.browserTabId } }]
        }
        return []
      }),
      canToggleAgentPane: true,
      canToggleSidebar: true,
      initialIntent,
    })
    console.info('[universal-menu] result in workspace', { type: result.type, workspaceId: ctx.workspace.id })
    if (result.type === 'open-pane') {
      if (result.target === 'global') void openGlobalPane(result.content)
      else openPane(result.content)
    }
    if (result.type === 'create-shell') openPendingShellPane(result.cwd)
    if (result.type === 'create-agent-chat') createWorkspaceChat(result.bootstrap)
    if (result.type === 'created-agent-chat') void selectCreatedChat(result.sessionId, result.workspaceId)
    if (result.type === 'workspace-bootstrap') {
      void bootstrapWorkspace(result.request)
    }
    if (result.type === 'switch-workspace') {
      void navigate({ to: '/w/$workspaceId', params: { workspaceId: result.workspaceId }, search: { chat: undefined, tab: undefined } })
    }
    if (result.type === 'close-tab') closeActiveTab()
    if (result.type === 'toggle-agent-pane') setAgentCollapsed(!agentCollapsed)
    if (result.type === 'toggle-sidebar') setSidebarHidden((v) => !v)
    if (result.type === 'open-settings') void navigate({ to: '/settings' })
  }, [agentCollapsed, bootstrapWorkspace, closeActiveTab, createWorkspaceChat, ctx.localEnvTarget, ctx.uiState.activeAgentSessionId, ctx.uiState.workspaceTabs, ctx.workspace.folderId, ctx.workspace.id, ctx.workspace.name, navigate, openGlobalPane, openPane, openPendingShellPane, selectCreatedChat, setAgentCollapsed])

  useEffect(() => {
    prewarmOverlayLayer()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        void openCommandPalette()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 't') {
        e.preventDefault()
        void openCommandPalette(universalMenuIntentForTabShortcut(e.shiftKey))
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setSidebarHidden((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        setAgentCollapsed(!agentCollapsed)
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        if (focusedTabGroup === 'agent') setCloseAgentTabSignal((signal) => signal + 1)
        else closeActiveTab()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [agentCollapsed, closeActiveTab, focusedTabGroup, openCommandPalette, setAgentCollapsed])

  return (
    <>
    <WorkspaceEnvTargetProvider>
      <WorkspaceBootstrapRunner dispatchWorkspaceState={dispatchWorkspaceState} appQueryClient={queryClient} />
    </WorkspaceEnvTargetProvider>
    <div className="relative flex h-screen max-h-screen w-screen overflow-hidden bg-neutral-975 text-neutral-100">
      {!sidebarHidden && (
        <WorkspaceSidebar
          dispatchWorkspaceState={dispatchWorkspaceState}
          onHide={() => setSidebarHidden(true)}
          onNewWorkspaceIntent={() => void openCommandPalette('new-workspace')}
          globalTabsDestination={{ workspace: globalTabsWorkspace, tabs: globalTabs, activeTabId: activeGlobalTab?.id ?? null }}
          onSelectGlobalTab={(tabId) => showGlobalTab(tabId)}
          onLeaveGlobalTabs={() => void navigate({ to: '/w/$workspaceId', params: { workspaceId: ctx.workspace.id }, search: { chat: undefined, tab: undefined } })}
          onCloseGlobalTab={(tabId) => {
            const tab = globalTabs.find((candidate) => candidate.id === tabId)
            if (!tab || !globalTabsWorkspace) return
            closeWorkspaceTab(tab, {
              type: 'closeTab',
              closeTab: (closingTabId) => void closeWorkspaceTabCommand({ workspaceId: globalTabsWorkspace.id, tabId: closingTabId, activateFallback: false }),
              onActiveTabClosed: tabId === activeGlobalTab?.id
                ? () => showGlobalTab(nextGlobalTabIdAfterClose(globalTabs, tabId))
                : undefined,
            })
          }}
        />
      )}
      {activeGlobalTab && globalTabsWorkspace ? (
        <GlobalBrowserTabPane
          workspaceId={globalTabsWorkspace.id}
          tab={activeGlobalTab}
          tabs={globalTabs}
          onActiveTabFallback={(tabId) => showGlobalTab(tabId)}
        />
      ) : (
        <ShellChrome
          key={ctx.workspace.id}
          className="h-screen max-h-screen min-w-0 flex-1 overflow-hidden bg-neutral-975"
          style={{ width: sidebarHidden ? '100vw' : undefined }}
          showHeader={false}
          title={ctx.workspace.name}
          subtitle={ctx.localEnvTarget ? `local · ${ctx.localEnvTarget.env.label}` : 'local env unavailable'}
          splitStorageKey={`workspace.${ctx.workspace.id}.splitRatio`}
          splitInitialRatio={ctx.uiState.splitRatio ?? 0.7}
          preferredLeftWidth={ctx.uiState.workspaceTabs.length === 0 && !agentCollapsed ? 800 : undefined}
          leftCollapsed={agentCollapsed}
          onSplitRatioChange={onSplitRatioChange}
          actions={null}
          left={
            <WorkspaceAgentPane
              collapsed={agentCollapsed}
              onToggleCollapsed={() => setAgentCollapsed(!agentCollapsed)}
              onSessionListChange={setAgentSessionCount}
              dispatchWorkspaceState={dispatchWorkspaceState}
              focused={focusedTabGroup === 'agent'}
              closeActiveTabSignal={closeAgentTabSignal}
              onFocusTabs={() => setFocusedTabGroup('agent')}
              onOpenUniversalMenu={() => void openCommandPalette()}
            />
          }
          right={
            ctx.uiState.workspaceTabs.length > 0 ? (
              <WorkspaceTabPane
                dispatchWorkspaceState={dispatchWorkspaceState}
                focused={focusedTabGroup === 'workspace'}
                onFocusTabs={() => setFocusedTabGroup('workspace')}
              />
            ) : (
              <WorkspaceEmptyPaneCta onOpenPalette={() => void openCommandPalette()} />
            )
          }
        />
      )}
    </div>
    </>
  )
}

function WorkspaceBootstrapRunner({ dispatchWorkspaceState, appQueryClient }: { dispatchWorkspaceState: WorkspaceUiDispatch; appQueryClient: QueryClient }) {
  const ctx = useWorkspaceContext()
  const navigate = useNavigate()
  const envQueryClient = useQueryClient()
  const cloneConfig = envTrpc.repo.cloneConfig.useMutation()
  const startChat = envTrpc.agent.sessionStart.useMutation()
  const upsertResource = trpc.workspace.upsertResource.useMutation()
  const servicesRef = useRef({ appQueryClient, cloneConfig, dispatchWorkspaceState, envQueryClient, navigate, startChat, upsertResource })

  useEffect(() => {
    servicesRef.current = { appQueryClient, cloneConfig, dispatchWorkspaceState, envQueryClient, navigate, startChat, upsertResource }
  }, [appQueryClient, cloneConfig, dispatchWorkspaceState, envQueryClient, navigate, startChat, upsertResource])

  useEffect(() => {
    console.info('[workspace-bootstrap] runner check', {
      workspaceId: ctx.workspace.id,
      pending: pendingWorkspaceBootstraps.has(ctx.workspace.id),
      running: runningWorkspaceBootstraps.has(ctx.workspace.id),
    })
    const bootstrap = takeWorkspaceBootstrap(ctx.workspace.id)
    if (!bootstrap) return
    const job = bootstrap
    let cancelled = false
    async function run() {
      try {
        console.info('[workspace-bootstrap] runner start', { workspaceId: job.workspaceId, type: job.type })
        let workingDir: string
        let repoId: string | undefined
        let resourceName: string | undefined
        if (job.type === 'repoConfig') {
          setWorkspaceBootstrapStatus(job.workspaceId, { message: 'Cloning worktree…' })
          console.info('[workspace-bootstrap] clone start', { workspaceId: job.workspaceId, configId: job.configId, worktreeName: job.worktreeName })
          const cloned = await servicesRef.current.cloneConfig.mutateAsync({ configId: job.configId, worktreeName: job.worktreeName }) as { repoId: string; workingDir: string }
          console.info('[workspace-bootstrap] clone success', { workspaceId: job.workspaceId, repoId: cloned.repoId, workingDir: cloned.workingDir })
          workingDir = cloned.workingDir
          repoId = cloned.repoId
          resourceName = job.worktreeName
        } else if (job.type === 'worktree') {
          workingDir = job.path
          repoId = job.repoId
          resourceName = job.name
        } else {
          workingDir = job.path
        }

        if (job.type !== 'folder') {
          setWorkspaceBootstrapStatus(job.workspaceId, { message: 'Linking worktree…' })
          console.info('[workspace-bootstrap] resource upsert start', { workspaceId: job.workspaceId, repoId, workingDir })
          await servicesRef.current.upsertResource.mutateAsync({
            workspaceId: job.workspaceId,
            resource: {
              type: 'worktree',
              resourceKey: repoId ? `repo:${repoId}` : `path:${workingDir}`,
              shared: true,
              data: { repoId, workingDir, name: resourceName },
            },
          })
          console.info('[workspace-bootstrap] resource upsert success', { workspaceId: job.workspaceId })
        }

        setWorkspaceBootstrapStatus(job.workspaceId, { message: 'Creating chat…' })
        console.info('[workspace-bootstrap] session start start', { workspaceId: job.workspaceId, workingDir })
        const session = await servicesRef.current.startChat.mutateAsync({ workspaceId: job.workspaceId, directory: workingDir }) as { id: string }
        console.info('[workspace-bootstrap] session start success', { workspaceId: job.workspaceId, sessionId: session.id })
        await Promise.all([
          servicesRef.current.envQueryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList', { workspaceId: job.workspaceId }) }),
          servicesRef.current.envQueryClient.invalidateQueries({ queryKey: trpcQueryKey('repo.listRecentFolders') }),
          servicesRef.current.envQueryClient.invalidateQueries({ queryKey: trpcQueryKey('repo.listWorktrees') }),
        ])
        console.info('[workspace-bootstrap] invalidate complete', { workspaceId: job.workspaceId })
        if (cancelled) return
        servicesRef.current.dispatchWorkspaceState({ type: 'setActiveAgentSession', sessionId: session.id })
        console.info('[workspace-bootstrap] chat navigate start', { workspaceId: job.workspaceId, sessionId: session.id })
        await servicesRef.current.navigate({
          to: '/w/$workspaceId',
          params: { workspaceId: job.workspaceId },
          search: (prev) => ({ ...prev, chat: session.id, tab: undefined }),
          replace: true,
        })
        console.info('[workspace-bootstrap] chat navigate complete', { workspaceId: job.workspaceId, sessionId: session.id })
        finishWorkspaceBootstrap(job.workspaceId)
      } catch (error) {
        console.error('[workspace-bootstrap] runner error', error)
        if (!cancelled) failWorkspaceBootstrap(job.workspaceId, extractTrpcMessage(error))
      }
    }
    void run()
    return () => {
      console.info('[workspace-bootstrap] runner cleanup', { workspaceId: job.workspaceId, type: job.type })
      cancelled = true
    }
  }, [ctx.workspace.id])

  return null
}

function WorkspaceEmptyPaneCta({ onOpenPalette }: { onOpenPalette: () => void }) {
  return (
    <section className="flex h-full min-h-0 w-full items-center justify-center bg-neutral-975 p-8" aria-label="Workspace empty pane">
      <button
        type="button"
        onClick={onOpenPalette}
        className="group flex items-center gap-3 text-xs text-neutral-600 transition-colors hover:text-neutral-300"
      >
        <span>Open a shell, file, or browser pane</span>
        <span className="rounded border border-neutral-800 bg-neutral-900/60 px-1.5 py-0.5 text-[12px] uppercase tracking-wide text-neutral-400 group-hover:bg-neutral-900 group-hover:text-neutral-200">
          ⌘K
        </span>
      </button>
    </section>
  )
}

export function WorkspaceSidebar({
  dispatchWorkspaceState,
  onHide,
  onNewWorkspaceIntent,
  globalTabsDestination,
  onSelectGlobalTab,
  onLeaveGlobalTabs,
  onCloseGlobalTab,
}: {
  dispatchWorkspaceState: WorkspaceUiDispatch
  onHide: () => void
  onNewWorkspaceIntent: () => void
  globalTabsDestination?: GlobalTabDestination
  onSelectGlobalTab?: (tabId: string) => void
  onLeaveGlobalTabs?: () => void
  onCloseGlobalTab?: (tabId: string) => void
}) {
  const ctx = useWorkspaceContext()
  const navigate = useNavigate()
  const trpcUtils = trpc.useUtils()
  const nodes = useWorkspaceSidebarTree()
  const workspaces = useVisibleWorkspaces()
  const resourcesStore = useWorkspaceResourcesStore()
  const deleteResource = trpc.workspace.deleteResource.useMutation()
  const [edit, dispatchEdit] = useReducer(renameEditReducer, idleRenameEditState)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [dragPlacement, setDragPlacement] = useState<DropPlacement>('after')
  const [dropProjection, setDropProjection] = useState<SidebarDropProjection | null>(null)
  const [localTree, setLocalTree] = useState<WorkspaceSidebarNode[] | null>(null)
  const [selectedDndIds, setSelectedDndIds] = useState<Set<string>>(() => new Set())
  const [sidebarWidth, setSidebarWidth] = useState(() => readWorkspaceSidebarWidth())
  const [chatReadVersion, setChatReadVersion] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const selectedDndIdsRef = useRef<Set<string>>(new Set())
  const lastSelectedDndIdRef = useRef<string | null>(null)
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)
  const dragPointerOffsetRef = useRef<{ x: number; y: number } | null>(null)
  const lastProjectionRef = useRef<SidebarDropProjection | null>(null)
  const lastProjectionKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (edit.editingId) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [edit.editingId])

  useEffect(() => {
    if (!ctx.uiState.activeAgentSessionId) return
    markWorkspaceChatsRead(ctx.workspace.id)
    setChatReadVersion((version) => version + 1)
  }, [ctx.uiState.activeAgentSessionId, ctx.workspace.id])

  async function saveRename() {
    if (!edit.editingId) return
    const nextName = nextRenameValue(edit)
    if (nextName) {
      if (edit.editingKind === 'folder') {
        await renameWorkspaceFolder({ id: edit.editingId, name: nextName })
      } else {
        await renameWorkspace({ id: edit.editingId, name: nextName })
      }
    }
    dispatchEdit({ type: 'saved' })
  }

  async function closeWorkspace(workspaceId: string, workspaces: WorkspaceSummary[]) {
    const tabs = await trpcUtils.workspace.listTabs.fetch({ workspaceId }).catch(() => [])
    await closeNativeBrowserTabsForWorkspace(tabs)
    const remaining = workspaces.filter((workspace) => workspace.id !== workspaceId)
    const next = remaining[0]
    if (workspaceId === ctx.workspace.id) {
      if (next) {
        await navigate({
          to: '/w/$workspaceId',
          params: { workspaceId: next.id },
          search: { chat: undefined, tab: undefined },
          replace: true,
        })
      } else {
        await navigate({ to: '/', replace: true })
      }
    }
    await archiveWorkspace(workspaceId)
    for (const resource of resourcesStore.records.filter((record) => record.workspaceId === workspaceId)) {
      await deleteResource.mutateAsync({ id: resource.id }).catch(() => undefined)
    }
  }

  const displayNodes = localTree ?? nodes
  const workspaceNames = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces])
  const dndNodes = displayNodes as unknown as SidebarTreeNode[]
  const flatRows = flattenSidebarTree(dndNodes)
  const sortableIds = flatRows.map((row) => sidebarDndId(row.kind, row.id))
  const selectableIds = useMemo(() => new Set(sortableIds), [sortableIds])
  const sortingStrategy = dropProjection?.placement === 'inside' ? noSortingDisplacementStrategy : verticalListSortingStrategy
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    const current = selectedDndIdsRef.current
    const next = new Set([...current].filter((id) => selectableIds.has(id)))
    if (next.size === current.size && [...next].every((id) => current.has(id))) return
    selectedDndIdsRef.current = next
    setSelectedDndIds(next)
  }, [selectableIds])

  function setSidebarSelection(next: Set<string>) {
    selectedDndIdsRef.current = next
    setSelectedDndIds(next)
  }

  function updateSelection(event: ReactMouseEvent, dndId: string) {
    const range = event.shiftKey && lastSelectedDndIdRef.current
    const additive = event.metaKey || event.ctrlKey
    if (event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
    }
    if (range) {
      const start = sortableIds.indexOf(lastSelectedDndIdRef.current!)
      const end = sortableIds.indexOf(dndId)
      if (start >= 0 && end >= 0) {
        const [from, to] = start < end ? [start, end] : [end, start]
        const next = additive ? new Set(selectedDndIdsRef.current) : new Set<string>()
        for (const id of sortableIds.slice(from, to + 1)) next.add(id)
        setSidebarSelection(next)
        return true
      }
    }
    if (event.shiftKey) {
      setSidebarSelection(new Set([dndId]))
      lastSelectedDndIdRef.current = dndId
      return true
    }
    if (additive) {
      event.preventDefault()
      event.stopPropagation()
      const next = new Set(selectedDndIdsRef.current)
      if (next.has(dndId)) next.delete(dndId)
      else next.add(dndId)
      setSidebarSelection(next)
      lastSelectedDndIdRef.current = dndId
      return true
    }
    setSidebarSelection(new Set())
    lastSelectedDndIdRef.current = dndId
    return false
  }

  async function createFolderFromSelection() {
    if (creatingFolder || edit.editingId) return
    setCreatingFolder(true)
    const effectiveSelection = new Set(selectedDndIdsRef.current)
    try {
      effectiveSelection.add(sidebarDndId('workspace', ctx.workspace.id))
      const selectedRows = flatRows.filter((row) => effectiveSelection.has(sidebarDndId(row.kind, row.id)))
      const movableRows = selectedRows.filter((row) => !selectedRows.some((candidate) => (
        candidate.kind === 'folder' && candidate.id !== row.id && row.ancestorFolderIds.includes(candidate.id)
      )))
      const commonParent = movableRows.length > 0 && movableRows.every((row) => row.parentFolderId === movableRows[0]?.parentFolderId)
        ? movableRows[0]?.parentFolderId ?? null
        : null
      const firstSelectedDndId = movableRows[0] ? sidebarDndId(movableRows[0].kind, movableRows[0].id) : null
      const folder = await createWorkspaceFolder({ name: 'New folder', parentId: commonParent })
      const folderDndId = sidebarDndId('folder', folder.id)
      if (firstSelectedDndId) {
        await moveWorkspaceSidebarNode({
          nodeType: 'folder',
          nodeId: folder.id,
          parentFolderId: commonParent,
          beforeNodeId: firstSelectedDndId,
        })
      }
      for (const row of movableRows) {
        await moveWorkspaceSidebarNode({
          nodeType: row.kind,
          nodeId: row.id,
          parentFolderId: folder.id,
          beforeNodeId: null,
        })
      }
      setSidebarSelection(new Set([folderDndId]))
      lastSelectedDndIdRef.current = folderDndId
      dispatchEdit({ type: 'begin', workspaceId: folder.id, name: folder.name, kind: 'folder' })
    } finally {
      setCreatingFolder(false)
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() !== 'g' || (!event.metaKey && !event.ctrlKey)) return
      if (isEditableEventTarget(event.target)) return
      event.preventDefault()
      void createFolderFromSelection()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  async function selectCreatedChat(sessionId: string, workspaceId?: string) {
    if (!workspaceId) return
    if (workspaceId === ctx.workspace.id) {
      dispatchWorkspaceState({ type: 'setActiveAgentSession', sessionId })
    }
    await navigate({
      to: '/w/$workspaceId',
      params: { workspaceId },
      search: { chat: sessionId, tab: undefined },
    })
  }

  function updatePointerDropProjection(activeId: string, pointer: { x: number; y: number }) {
    const projected = projectDropFromPointer(activeId, pointer, dndNodes, dragPointerOffsetRef.current)
    setDropProjection(projected)
    lastProjectionRef.current = projected
    setDragPlacement(projected?.placement ?? 'after')
    const key = projectionKey(projected)
    if (!projected) lastProjectionKeyRef.current = null
    if (projected && key !== lastProjectionKeyRef.current) {
      lastProjectionKeyRef.current = key
      setLocalTree((current) => moveSidebarNodeInTree(
        (current ?? displayNodes) as unknown as SidebarTreeNode[],
        projected,
      ) as unknown as WorkspaceSidebarNode[])
    }
  }

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id)
    const parsed = parseSidebarDndId(id)
    const startingTree = parsed?.kind === 'folder'
      ? setSidebarFolderCollapsedInTree(displayNodes as unknown as SidebarTreeNode[], parsed.id, true) as unknown as WorkspaceSidebarNode[]
      : displayNodes
    setActiveDragId(id)
    setDropProjection(null)
    lastProjectionRef.current = null
    lastProjectionKeyRef.current = null
    dragPointerOffsetRef.current = dragPointerOffsetFromEvent(id, event.activatorEvent)
    setLocalTree(startingTree)
    if (parsed?.kind === 'folder') {
      void setWorkspaceFolderCollapsed({ id: parsed.id, collapsed: true })
    }
  }

  function handleDragMove(event: DragMoveEvent) {
    const pointer = pointerFromDragEvent(event.activatorEvent, event.delta.x, event.delta.y)
    lastPointerRef.current = pointer
    updatePointerDropProjection(String(event.active.id), pointer)
  }

  function handleDragOver(event: DragOverEvent) {
    if (!event.over) {
      setDropProjection(null)
      lastProjectionRef.current = null
      lastProjectionKeyRef.current = null
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const pointer = lastPointerRef.current ?? pointerFromDragEvent(event.activatorEvent, event.delta.x, event.delta.y)
    const projection = projectDropFromPointer(String(event.active.id), pointer, dndNodes, dragPointerOffsetRef.current) ?? lastProjectionRef.current ?? dropProjection
    if (!projection) {
      setActiveDragId(null)
      setDropProjection(null)
      lastPointerRef.current = null
      dragPointerOffsetRef.current = null
      lastProjectionRef.current = null
      lastProjectionKeyRef.current = null
      setLocalTree(null)
      return
    }
    const optimisticTree = moveSidebarNodeInTree(dndNodes, projection) as unknown as WorkspaceSidebarNode[]
    setLocalTree(optimisticTree)
    setActiveDragId(null)
    setDropProjection(null)
    lastPointerRef.current = null
    dragPointerOffsetRef.current = null
    lastProjectionRef.current = null
    lastProjectionKeyRef.current = null
    try {
      await moveWorkspaceSidebarNode({
        nodeType: projection.activeKind,
        nodeId: projection.activeId,
        parentFolderId: projection.parentFolderId,
        beforeNodeId: projection.beforeNodeId,
      })
    } catch (err) {
      console.warn('workspace sidebar move failed', err)
    } finally {
      setLocalTree(null)
    }
  }

  function handleDragCancel() {
    setActiveDragId(null)
    setDropProjection(null)
    lastPointerRef.current = null
    dragPointerOffsetRef.current = null
    lastProjectionRef.current = null
    lastProjectionKeyRef.current = null
    setLocalTree(null)
  }

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = sidebarWidth
    let latestWidth = startWidth
    function onMove(moveEvent: PointerEvent) {
      const next = clampSidebarWidth(startWidth + moveEvent.clientX - startX)
      latestWidth = next
      setSidebarWidth(next)
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      writeWorkspaceSidebarWidth(latestWidth)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  return (
    <>
    <aside
      className="relative flex h-screen max-h-screen shrink-0 flex-col overflow-hidden border-r border-neutral-800 bg-neutral-950"
      style={{ width: sidebarWidth }}
      aria-label="Workspaces"
    >
      <div
        onPointerDown={startSidebarResize}
        className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize bg-transparent hover:bg-neutral-800"
        aria-hidden="true"
      />
      <div className="window-drag flex flex-none basis-8 items-center justify-between gap-2 border-b border-neutral-800 bg-neutral-950 px-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-neutral-300">kaivo</div>
        </div>
        <div className="flex items-center">
          <button
            onClick={onNewWorkspaceIntent}
            className="rounded px-0.5 py-0.5 text-neutral-600 hover:bg-neutral-900 hover:text-neutral-200 disabled:opacity-50"
            aria-label="Create new workspace"
            title="New workspace"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <GlobalTabsSidebarSection
          destination={globalTabsDestination ?? { workspace: null, tabs: [], activeTabId: null }}
          onSelect={(tabId) => {
            setSidebarSelection(new Set())
            lastSelectedDndIdRef.current = null
            onSelectGlobalTab?.(tabId)
          }}
          onClose={(tabId) => onCloseGlobalTab?.(tabId)}
        />
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragOver={handleDragOver}
          onDragEnd={(event) => void handleDragEnd(event)}
          onDragCancel={handleDragCancel}
        >
          <SortableContext items={sortableIds} strategy={sortingStrategy}>
            {flatRows.map((row) => renderSidebarRow(row))}
          </SortableContext>
          {displayNodes.length === 0 && <div className="px-2 py-1.5 text-[11px] text-neutral-600">No workspaces</div>}
          <DragOverlay dropAnimation={null}>
            {activeDragId ? <SidebarDragPreview activeId={activeDragId} nodes={displayNodes} /> : null}
          </DragOverlay>
        </DndContext>
        <WorkspaceSidebarNotifications
          workspaceNames={workspaceNames}
          activeWorkspaceId={ctx.workspace.id}
          activeSessionId={ctx.uiState.activeAgentSessionId}
          dispatchWorkspaceState={dispatchWorkspaceState}
        />
      </div>
      <div className="flex-none border-t border-neutral-900 px-2 py-2">
        <Link
          to="/settings"
          className="flex items-center gap-2 rounded px-[3px] py-1 text-xs text-neutral-500 transition-colors hover:bg-highlight hover:text-neutral-200"
        >
          <Settings className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate font-medium">Settings</span>
        </Link>
      </div>
    </aside>
    </>
  )

  function renderSidebarRow(row: FlatSidebarNode): ReactNode {
    if (row.kind === 'folder') {
      const folder = findSidebarFolder(displayNodes, row.id)
      if (!folder) return null
      const dndId = sidebarDndId('folder', folder.id)
      const folderHasVisibleChildren = !folder.collapsed && flatRows.some((candidate) => candidate.ancestorFolderIds.includes(folder.id))
      const editing = edit.editingId === folder.id && edit.editingKind === 'folder'
      const selected = selectedDndIds.has(dndId)
      return (
        <SortableSidebarRow
          key={dndId}
          id={dndId}
          depth={row.depth}
          active={activeDragId === dndId}
          disabled={Boolean(edit.editingId)}
          guideDepths={row.ancestorFolderIds.map((_, index) => index)}
        >
          <div className="relative mb-0.5">
            {folderHasVisibleChildren && (
              <span
                className="pointer-events-none absolute bottom-[-5px] left-[3.5px] top-[20px] border-l border-neutral-800/80"
                aria-hidden="true"
              />
            )}
            <div className="group flex items-center gap-px py-px text-xs text-neutral-400 transition-all duration-150">
              <button
                onClick={() => void setWorkspaceFolderCollapsed({ id: folder.id, collapsed: !folder.collapsed })}
                className="-ml-0.5 flex h-4 w-3 shrink-0 items-center justify-center rounded text-neutral-500 hover:text-neutral-300"
                aria-label={`${folder.collapsed ? 'Expand' : 'Collapse'} folder ${folder.name}`}
              >
                {folder.collapsed ? <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
              </button>
              <div className={
                'flex min-w-0 flex-1 items-center rounded px-1.5 py-0.5 group-hover:bg-highlight group-hover:text-neutral-200 ' +
                (selected ? 'bg-highlight text-neutral-100 ring-1 ring-neutral-700 ' : '') +
                (dropProjection?.overId === folder.id && dropProjection?.placement === 'inside' ? 'bg-highlight text-neutral-100 ring-1 ring-neutral-600 shadow-[0_0_0_3px_rgba(56,189,248,0.10)]' : '')
              }
              onClick={(e) => {
                if (updateSelection(e, dndId)) return
                if (!editing) void setWorkspaceFolderCollapsed({ id: folder.id, collapsed: !folder.collapsed })
              }}>
                {editing ? (
                  <input
                    ref={inputRef}
                    value={edit.draft}
                    onChange={(e) => dispatchEdit({ type: 'change', draft: e.target.value })}
                    onBlur={() => void saveRename()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveRename()
                      if (e.key === 'Escape') dispatchEdit({ type: 'cancel' })
                    }}
                    className="min-w-0 flex-1 bg-transparent px-0.5 py-0.5 text-xs font-medium text-neutral-100 outline-none"
                    aria-label="Folder name"
                  />
                ) : (
                  <span
                    className="min-w-0 flex-1 truncate px-0.5 font-medium"
                    title={folder.name}
                    onDoubleClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      dispatchEdit({ type: 'begin', workspaceId: folder.id, name: folder.name, kind: 'folder' })
                    }}
                  >
                    {folder.name}
                  </span>
                )}
              </div>
            </div>
          </div>
        </SortableSidebarRow>
      )
    }
    const workspace = findSidebarWorkspace(displayNodes, row.id)
    if (!workspace) return null
    const dndId = sidebarDndId('workspace', workspace.id)
    const editing = edit.editingId === workspace.id && edit.editingKind === 'workspace'
    const activeGlobalTabId = globalTabsDestination?.activeTabId ?? null
    const active = workspaceSidebarRowActive(workspace.id, ctx.workspace.id, activeGlobalTabId)
    const selected = selectedDndIds.has(dndId)
    const showChatRollup = Boolean(ctx.localEnvTarget?.available && ctx.localEnvTarget.token)
    const workspaceHref = `/w/${workspace.id}`
    const workspaceRowClassName = 'min-w-0 flex-1 truncate rounded px-0.5 py-0.5 text-left text-xs font-medium'
    const handleWorkspaceLinkClick = (e: ReactMouseEvent) => {
      onLeaveGlobalTabs?.()
      if (updateSelection(e, dndId)) return
      if (!activeGlobalTabId) return
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.button !== 0) return
      e.preventDefault()
      void navigate({
        to: '/w/$workspaceId',
        params: { workspaceId: workspace.id },
        search: { chat: undefined, tab: undefined },
      })
    }
    return (
      <SortableSidebarRow
        key={dndId}
        id={dndId}
        depth={row.depth}
        active={activeDragId === dndId}
        disabled={Boolean(edit.editingId)}
        guideDepths={row.ancestorFolderIds.map((_, index) => index)}
      >
        <div className="relative mb-0.5">
          <div className="group flex items-center gap-px text-neutral-400">
            <span className="h-4 w-1 shrink-0" aria-hidden="true" />
            <div className={
              'relative flex min-w-0 flex-1 items-center rounded px-1.5 py-0.5 transition-colors group-hover:bg-highlight group-hover:text-neutral-200 ' +
              (active || selected ? 'bg-highlight text-neutral-100 ' : 'text-neutral-400') +
              (selected ? 'ring-1 ring-neutral-700 ' : '')
            }>
              {editing ? (
                <input
                  ref={inputRef}
                  value={edit.draft}
                  onChange={(e) => dispatchEdit({ type: 'change', draft: e.target.value })}
                  onBlur={() => void saveRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void saveRename()
                    if (e.key === 'Escape') dispatchEdit({ type: 'cancel' })
                  }}
                  className="min-w-0 flex-1 bg-transparent px-0.5 py-0.5 text-xs font-medium text-neutral-100 outline-none"
                  aria-label="Workspace name"
                />
              ) : (
                activeGlobalTabId ? (
                  <a
                    href={workspaceHref}
                    aria-current={active ? 'page' : undefined}
                    onClick={handleWorkspaceLinkClick}
                    onDoubleClick={(e) => {
                      e.preventDefault()
                      dispatchEdit({ type: 'begin', workspaceId: workspace.id, name: workspace.name })
                    }}
                    className={workspaceRowClassName}
                    title={workspace.name}
                  >
                    {workspace.name}
                  </a>
                ) : (
                  <Link
                    to="/w/$workspaceId"
                    params={{ workspaceId: workspace.id }}
                    search={{ chat: undefined, tab: undefined }}
                    aria-current={active ? 'page' : undefined}
                    onClick={handleWorkspaceLinkClick}
                    onDoubleClick={(e) => {
                      e.preventDefault()
                      dispatchEdit({ type: 'begin', workspaceId: workspace.id, name: workspace.name })
                    }}
                    className={workspaceRowClassName}
                    title={workspace.name}
                  >
                    {workspace.name}
                  </Link>
                )
              )}
              {showChatRollup && (
                <span className="pointer-events-none absolute right-1.5 flex items-center transition-transform duration-150 group-hover:-translate-x-10">
                  <WorkspaceAgentEnvProvider>
                    <WorkspaceSidebarChatCount
                      workspaceId={workspace.id}
                      active={active}
                      activeSessionId={ctx.uiState.activeAgentSessionId}
                      readVersion={chatReadVersion}
                      onMarkRead={() => setChatReadVersion((version) => version + 1)}
                    />
                  </WorkspaceAgentEnvProvider>
                </span>
              )}
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const target = ctx.localEnvTarget
                  if (!target?.available || !target.token) return
                  void openWorkspaceCleanupOverlay({
                    workspace,
                    allWorkspaces: workspaces,
                    resources: resourcesStore.records,
                    env: target.env,
                    envToken: target.token,
                  }).then((cleaned) => {
                    if (cleaned) void closeWorkspace(workspace.id, workspaces)
                  }).catch((error) => console.warn('workspace cleanup overlay failed', error))
                }}
                className="rounded px-0.5 py-0.5 text-neutral-600 opacity-0 hover:text-neutral-200 group-hover:opacity-100"
                aria-label={`Close workspace ${workspace.name}`}
                title="Close workspace"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </SortableSidebarRow>
    )
  }
}

export function GlobalTabsSidebarSection({
  destination,
  onSelect,
  onClose,
}: {
  destination: GlobalTabDestination
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
}) {
  const browserTabs = destination.tabs.filter((tab): tab is Extract<WorkspaceTab, { type: 'browser' }> => tab.type === 'browser')
  const faviconOrigins = useMemo(() => Array.from(new Set(
    browserTabs
      .map((tab) => faviconOriginForUrl(tab.url))
      .filter((origin): origin is string => Boolean(origin)),
  )), [browserTabs])
  const faviconCache = trpc.favicon.getByOrigins.useQuery(
    { origins: faviconOrigins },
    { enabled: faviconOrigins.length > 0, staleTime: 60_000 },
  )

  if (browserTabs.length === 0) return null

  return (
    <section className="mb-2 border-b border-neutral-900 pb-2" aria-label="Global tabs">
      <div className="space-y-0.5">
        {browserTabs.map((tab) => {
          const active = tab.id === destination.activeTabId
          const label = globalTabLabel(tab)
          return (
            <div key={tab.id} className="group flex items-center gap-px text-neutral-400">
              <span className="h-4 w-1 shrink-0" aria-hidden="true" />
              <div className={
                'relative flex min-w-0 flex-1 items-center rounded px-1.5 py-0.5 transition-colors group-hover:bg-highlight group-hover:text-neutral-200 ' +
                (active ? 'bg-highlight text-neutral-100 ' : 'text-neutral-400')
              }>
                <button
                  type="button"
                  onClick={() => onSelect(tab.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-xs font-medium"
                  title={label}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="shrink-0">
                    <TabIconView
                      icon={browserTabIconForUrl({
                        url: tab.url,
                        records: (faviconCache.data ?? {}) as Record<string, FaviconCacheRecord>,
                        liveDataUrls: {},
                      })}
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onClose(tab.id)
                  }}
                  className="rounded px-0.5 py-0.5 text-neutral-600 opacity-0 hover:text-neutral-200 group-hover:opacity-100"
                  aria-label={`Close global tab ${label}`}
                  title="Close global tab"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function globalTabLabel(tab: Extract<WorkspaceTab, { type: 'browser' }>): string {
  const title = tab.title.trim()
  if (title && title !== 'Browser') return title
  try {
    const url = new URL(tab.url)
    return url.hostname || tab.url
  } catch {
    return tab.url || 'Browser'
  }
}

export function nextGlobalTabIdAfterClose(tabs: WorkspaceTab[], closingTabId: string): string | null {
  const browserTabs = tabs.filter((tab) => tab.type === 'browser')
  const idx = browserTabs.findIndex((tab) => tab.id === closingTabId)
  if (idx === -1) return browserTabs[0]?.id ?? null
  const remaining = browserTabs.filter((tab) => tab.id !== closingTabId)
  return remaining[idx]?.id ?? remaining[idx - 1]?.id ?? null
}

export function universalMenuIntentForTabShortcut(shiftKey: boolean): UniversalMenuInitialIntent {
  return shiftKey ? 'new-workspace' : 'default'
}

export function globalTabFromPaneContent(content: PaneContent, options?: { title?: string }): Extract<WorkspaceTab, { type: 'browser' }> | null {
  const tab = workspaceTabFromPaneContent(content, undefined, options)
  return tab?.type === 'browser' ? tab : null
}

export function globalTabUpsertInput(workspaceId: string, content: PaneContent, position: number, options?: { title?: string }): { workspaceId: string; tab: Extract<WorkspaceTab, { type: 'browser' }>; position: number } | null {
  const tab = globalTabFromPaneContent(content, options)
  return tab ? { workspaceId, tab, position } : null
}

export function workspaceSidebarRowActive(workspaceId: string, currentWorkspaceId: string, activeGlobalTabId: string | null): boolean {
  return workspaceId === currentWorkspaceId && !activeGlobalTabId
}

function GlobalBrowserTabPane({
  workspaceId,
  tab,
  tabs,
  onActiveTabFallback,
}: {
  workspaceId: string
  tab: WorkspaceTab
  tabs: WorkspaceTab[]
  onActiveTabFallback: (tabId: string | null) => void
}) {
  const [liveFaviconDataUrls, setLiveFaviconDataUrls] = useState<Record<string, string>>({})
  const pendingFaviconWritesRef = useRef(new Set<string>())
  const bookmarksStore = useBookmarksStore()
  const upsertResource = trpc.workspace.upsertResource.useMutation()
  const upsertFavicon = trpc.favicon.cacheFromUrl.useMutation()
  const faviconOrigin = tab.type === 'browser' ? faviconOriginForUrl(tab.url) : null
  const faviconCache = trpc.favicon.getByOrigins.useQuery(
    { origins: faviconOrigin ? [faviconOrigin] : [] },
    { enabled: Boolean(faviconOrigin), staleTime: 60_000 },
  )

  async function handleBrowserFaviconChange(input: { pageUrl: string; faviconUrl: string }) {
    const origin = faviconOriginForUrl(input.pageUrl)
    if (!origin) return
    const key = `${origin}:${input.faviconUrl}`
    if (pendingFaviconWritesRef.current.has(key)) return
    pendingFaviconWritesRef.current.add(key)
    try {
      const record = await upsertFavicon.mutateAsync({ pageOrigin: origin, iconUrl: input.faviconUrl })
      setLiveFaviconDataUrls((current) => ({ ...current, [origin]: record.dataUrl }))
      void faviconCache.refetch()
    } catch (error) {
      console.info('Favicon cache update failed', error)
    } finally {
      pendingFaviconWritesRef.current.delete(key)
    }
  }

  const dispatchGlobalWorkspaceState = useCallback<WorkspaceUiDispatch>((action) => {
    if (action.type === 'setBrowserTabId') {
      void setWorkspaceTabBrowserId({ workspaceId, tabId: action.tabId, browserTabId: action.browserTabId })
      const current = tabs.find((candidate) => candidate.id === action.tabId)
      if (current?.type === 'browser') {
        upsertResource.mutate({
          workspaceId,
          resource: {
            type: 'browser_tab',
            resourceKey: action.browserTabId,
            shared: false,
            data: { browserTabId: action.browserTabId, tabId: action.tabId, url: current.url, title: current.title },
          },
        })
      }
    } else if (action.type === 'setTabUrl') {
      void setWorkspaceTabUrl({ workspaceId, tabId: action.tabId, url: action.url })
    } else if (action.type === 'setTabTitle') {
      void setWorkspaceTabTitle({ workspaceId, tabId: action.tabId, title: action.title, source: 'explicit' })
    } else if (action.type === 'closeTab') {
      void closeWorkspaceTabCommand({ workspaceId, tabId: action.tabId, activateFallback: false })
    } else if (action.type === 'activateTab') {
      onActiveTabFallback(action.tabId)
    }
  }, [onActiveTabFallback, tabs, upsertResource, workspaceId])

  return (
    <section className="h-screen max-h-screen min-w-0 flex-1 overflow-hidden bg-neutral-975 text-neutral-500" aria-label="Global browser tab">
      <WorkspaceTabContent
        key={`${workspaceId}:${tab.id}`}
        workspaceId={workspaceId}
        tab={tab}
        onClose={() => {
          closeWorkspaceTab(tab, {
            type: 'closeTab',
            closeTab: (tabId) => void closeWorkspaceTabCommand({ workspaceId, tabId, activateFallback: false }),
            onActiveTabClosed: () => onActiveTabFallback(nextGlobalTabIdAfterClose(tabs, tab.id)),
          })
        }}
        onBrowserTabId={(browserTabId) => dispatchGlobalWorkspaceState({ type: 'setBrowserTabId', tabId: tab.id, browserTabId })}
        onUrlChange={(url) => dispatchGlobalWorkspaceState({ type: 'setTabUrl', tabId: tab.id, url })}
        onTitleChange={(title) => dispatchGlobalWorkspaceState({ type: 'setTabTitle', tabId: tab.id, title: truncateTabTitle(title) })}
        onFaviconChange={(input) => void handleBrowserFaviconChange(input)}
        bookmarks={bookmarksStore.bookmarks}
        faviconDataUrl={tab.type === 'browser'
          ? (liveFaviconDataUrls[faviconOriginForUrl(tab.url) ?? ''] ?? ((faviconCache.data ?? {}) as Record<string, FaviconCacheRecord>)[faviconOriginForUrl(tab.url) ?? '']?.dataUrl ?? null)
          : null}
        faviconUrl={tab.type === 'browser'
          ? (((faviconCache.data ?? {}) as Record<string, FaviconCacheRecord>)[faviconOriginForUrl(tab.url) ?? '']?.iconUrl ?? null)
          : null}
      />
    </section>
  )
}

function WorkspaceSidebarChatCount({
  workspaceId,
  active,
  activeSessionId,
  readVersion: _readVersion,
  onMarkRead,
}: {
  workspaceId: string
  active: boolean
  activeSessionId: string | null
  readVersion: number
  onMarkRead: () => void
}) {
  const sessions = envTrpc.agent.sessionList.useQuery({ workspaceId }, { refetchOnWindowFocus: false })
  const runtime = useAgentRuntimeStore(workspaceId)
  const activeSessions = (sessions.data ?? []).filter((session) => session.status !== 'archived')
  const sessionIds = new Set(activeSessions.map((session) => session.id))
  for (const record of runtime.records) sessionIds.add(record.sessionId)
  const latestSessionActivityAt = activeSessions.reduce((latest, session) => {
    const time = session.lastActivityAt ? new Date(session.lastActivityAt).getTime() : 0
    return Math.max(latest, time)
  }, 0)
  const latestRuntimeActivityAt = runtime.records.reduce((latest, record) => Math.max(latest, record.lastActivityAt.getTime()), 0)
  const latestActivityAt = Math.max(latestSessionActivityAt, latestRuntimeActivityAt)
  const runningCount = runtime.records.filter((record) => record.running).length
  const pendingAttentionCount = runtime.records.filter((record) => record.pendingAttentionCount > 0).length
  const readAt = readWorkspaceChatsAt(workspaceId)
  useEffect(() => {
    if (!active || latestActivityAt <= readAt) return
    markWorkspaceChatsRead(workspaceId)
    onMarkRead()
  }, [active, activeSessionId, latestActivityAt, onMarkRead, readAt, workspaceId])
  if (!sessions.data && runtime.records.length === 0) return null
  const chatCount = sessionIds.size
  const newResponseCount = !active && runningCount === 0 && readAt > 0 && latestActivityAt > readAt ? 1 : 0
  const glyph = workspaceRollupGlyph(workspaceRollupState({
    chatCount,
    runningCount,
    pendingAttentionCount,
    newResponseCount,
  }))
  if (chatCount <= 1 && !glyph) return null
  return (
    <span className="flex shrink-0 items-center gap-1">
      {chatCount > 1 && <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] text-neutral-500">{chatCount}</span>}
      {glyph === '.' && <span className="h-1 w-1 rounded-full bg-running" aria-label="New chat response" />}
      {glyph === '*' && <span className="h-2.5 w-2.5 animate-spin rounded-full border border-running border-t-transparent" aria-label="Chat running" />}
      {glyph === '!' && <span className="w-3 text-center text-[10px] font-semibold text-amber-300" aria-label="Chat needs attention">!</span>}
    </span>
  )
}

function notificationBorderColor(kind: string): string {
  switch (kind) {
    case 'permission': return 'bg-purple-400'
    case 'question': return 'bg-sky-400'
    case 'error': return 'bg-red-400'
    default: return 'bg-running'
  }
}

function WorkspaceSidebarNotifications({
  workspaceNames,
  activeWorkspaceId,
  activeSessionId,
  dispatchWorkspaceState,
}: {
  workspaceNames: Map<string, string>
  activeWorkspaceId: string
  activeSessionId: string | null
  dispatchWorkspaceState: WorkspaceUiDispatch
}) {
  const navigate = useNavigate()
  const notifications = useAgentNotificationsStore()
  const [soundPrefs] = useAgentNotificationSoundPrefs()
  const seenNotificationIds = useRef<Set<string>>(new Set())
  const initializedSoundNotifications = useRef(false)
  const activeNotificationIds = notifications.records
    .filter((notification) => notification.sessionId === activeSessionId)
    .map((notification) => notification.id)
    .join('\0')
  const rows = notifications.records.filter((notification) => notification.sessionId !== activeSessionId)

  useEffect(() => {
    if (!initializedSoundNotifications.current) {
      seenNotificationIds.current = new Set(notifications.records.map((notification) => notification.id))
      initializedSoundNotifications.current = true
      return
    }
    for (const notification of notifications.records) {
      if (seenNotificationIds.current.has(notification.id)) continue
      seenNotificationIds.current.add(notification.id)
      if (shouldPlayAgentFinishedSound(notification, activeWorkspaceId, activeSessionId)) {
        void playAgentNotificationSound(readAgentNotificationSoundPrefs().soundId).catch(() => undefined)
      }
    }
  }, [activeSessionId, activeWorkspaceId, notifications.records, soundPrefs])

  useEffect(() => {
    if (activeSessionId && activeNotificationIds) void notifications.dismissForSession(activeSessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, activeNotificationIds])

  async function openNotification(notification: AgentNotificationRecord) {
    notifications.dismiss(notification.id)
    if (notification.workspaceId === activeWorkspaceId) {
      dispatchWorkspaceState({ type: 'setActiveAgentSession', sessionId: notification.sessionId })
    }
    await navigate({
      to: '/w/$workspaceId',
      params: { workspaceId: notification.workspaceId },
      search: { chat: notification.sessionId, tab: undefined },
    })
  }

  function clearNotifications() {
    for (const notification of rows) notifications.dismiss(notification.id)
  }

  if (rows.length === 0) return null
  return (
    <div className="mt-3 pt-2">
      <div className="flex items-center justify-between gap-2 px-1.5 pb-1">
        <div className="text-[0.64em] font-medium uppercase tracking-wide text-neutral-600">Notifications</div>
        <button
          type="button"
          onClick={clearNotifications}
          className="rounded px-1 py-0.5 text-[0.64em] text-neutral-600 hover:bg-neutral-900 hover:text-neutral-300"
        >
          Clear
        </button>
      </div>
      <div className="-mx-2 divide-y divide-neutral-900 border-y border-neutral-900">
        {rows.map((notification) => {
          const workspaceName = workspaceNames.get(notification.workspaceId) ?? null
          return (
            <div
              key={notification.id}
              className="group relative flex cursor-pointer items-start gap-1 px-2 py-1.5"
            >
              <span className={'absolute inset-y-0 right-0 w-0.5 ' + notificationBorderColor(notification.kind)} aria-hidden="true" />
              <button
                type="button"
                onClick={() => void openNotification(notification)}
                className="min-w-0 flex-1 px-1.5 text-left"
                title={`${workspaceName ?? 'Unknown workspace'} · ${notification.title} · ${new Date(notification.createdAt).toLocaleString()}`}
              >
                <div className="flex min-w-0 items-baseline gap-1.5 text-[0.74em] leading-snug">
                  <span className="truncate font-medium text-neutral-400">{workspaceName ?? 'Unknown workspace'}</span>
                  <span className="shrink-0 text-neutral-700">·</span>
                  <span className="truncate text-neutral-400/75">{notification.title}</span>
                </div>
                <div className="mt-1.5 line-clamp-2 text-[0.64em] leading-snug text-neutral-500">{notification.summary}</div>
              </button>
              <button
                type="button"
                onClick={() => notifications.dismiss(notification.id)}
                className="mt-0.5 rounded p-0.5 text-neutral-700 opacity-0 hover:bg-neutral-900 hover:text-neutral-300 group-hover:opacity-100"
                aria-label={`Dismiss notification ${notification.title}`}
                title="Dismiss notification"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function shouldPlayAgentFinishedSound(notification: AgentNotificationRecord, activeWorkspaceId: string, activeSessionId: string | null): boolean {
  if (notification.kind !== 'finished') return false
  const prefs = readAgentNotificationSoundPrefs()
  if (prefs.soundId === 'off') return false
  const notLookingAtSession = notification.workspaceId !== activeWorkspaceId || notification.sessionId !== activeSessionId || document.visibilityState !== 'visible'
  if (notLookingAtSession) return true
  const durationMs = readLastAgentRunDurationMs(notification.sessionId)
  return durationMs !== null && durationMs >= prefs.longRunThresholdSeconds * 1000
}

const sidebarAnimateLayoutChanges: AnimateLayoutChanges = (args) =>
  defaultAnimateLayoutChanges({ ...args, wasDragging: true })

const noSortingDisplacementStrategy: SortingStrategy = () => null

function SortableSidebarRow({
  id,
  active,
  disabled,
  depth,
  guideDepths = [],
  children,
}: {
  id: string
  active: boolean
  disabled?: boolean
  depth: number
  guideDepths?: number[]
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
    animateLayoutChanges: sidebarAnimateLayoutChanges,
    transition: {
      duration: 240,
      easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
    },
  })
  return (
    <div
      ref={setNodeRef}
      {...(disabled ? {} : attributes)}
      {...(disabled ? {} : listeners)}
      data-sidebar-dnd-id={id}
      className={
        'relative will-change-transform ' +
        (active || isDragging ? 'opacity-30' : '')
      }
      style={{
        paddingLeft: depth * 8,
        cursor: disabled ? undefined : active ? 'grabbing' : 'grab',
        transform: DndCss.Transform.toString(transform),
        transition,
      }}
    >
      {guideDepths.map((guideDepth) => (
        <span
          key={guideDepth}
          className="pointer-events-none absolute inset-y-[-2px] border-l border-neutral-800/80"
          style={{ left: guideDepth * 8 + 3.5 }}
          aria-hidden="true"
        />
      ))}
      {children}
    </div>
  )
}

function SidebarDragPreview({ activeId, nodes }: { activeId: string; nodes: WorkspaceSidebarNode[] }) {
  const parsed = parseSidebarDndId(activeId)
  const label = parsed ? findSidebarNodeLabel(nodes, parsed.kind, parsed.id) : null
  if (!label) return null
  return (
    <div className="rounded-md border border-white/10 bg-neutral-800/95 px-2 py-1 text-[11px] font-medium leading-tight text-neutral-100 shadow-xl ring-1 ring-black/30 backdrop-blur">
      {label}
    </div>
  )
}

function findSidebarNodeLabel(nodes: WorkspaceSidebarNode[], kind: 'folder' | 'workspace', id: string): string | null {
  for (const node of nodes) {
    if (node.type === 'folder') {
      if (kind === 'folder' && node.folder.id === id) return node.folder.name
      const child = findSidebarNodeLabel(node.children, kind, id)
      if (child) return child
    } else if (kind === 'workspace' && node.workspace.id === id) {
      return node.workspace.name
    }
  }
  return null
}

function findSidebarFolder(nodes: WorkspaceSidebarNode[], id: string): WorkspaceFolderRecord | null {
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    if (node.folder.id === id) return node.folder
    const child = findSidebarFolder(node.children, id)
    if (child) return child
  }
  return null
}

function findSidebarWorkspace(nodes: WorkspaceSidebarNode[], id: string): WorkspaceSummary | null {
  for (const node of nodes) {
    if (node.type === 'workspace') {
      if (node.workspace.id === id) return node.workspace
      continue
    }
    const child = findSidebarWorkspace(node.children, id)
    if (child) return child
  }
  return null
}

function pointerFromDragEvent(activatorEvent: Event, deltaX: number, deltaY: number): { x: number; y: number } {
  const startX = 'clientX' in activatorEvent && typeof activatorEvent.clientX === 'number' ? activatorEvent.clientX : 0
  const startY = 'clientY' in activatorEvent && typeof activatorEvent.clientY === 'number' ? activatorEvent.clientY : 0
  return { x: startX + deltaX, y: startY + deltaY }
}

function dragPointerOffsetFromEvent(activeDndId: string, activatorEvent: Event): { x: number; y: number } | null {
  if (typeof document === 'undefined') return null
  if (!('clientX' in activatorEvent) || typeof activatorEvent.clientX !== 'number') return null
  if (!('clientY' in activatorEvent) || typeof activatorEvent.clientY !== 'number') return null
  const escapedId = globalThis.CSS?.escape ? globalThis.CSS.escape(activeDndId) : activeDndId.replace(/"/g, '\\"')
  const element = document.querySelector<HTMLElement>(`[data-sidebar-dnd-id="${escapedId}"]`)
  if (!element) return null
  const rect = element.getBoundingClientRect()
  return { x: activatorEvent.clientX - rect.left, y: activatorEvent.clientY - rect.top }
}

function projectDropFromPointer(
  activeDndId: string,
  pointer: { x: number; y: number },
  nodes: Parameters<typeof projectSidebarDropFromRows>[0]['nodes'],
  dragPointerOffset: { x: number; y: number } | null,
): SidebarDropProjection | null {
  const active = parseSidebarDndId(activeDndId)
  if (!active || typeof document === 'undefined') return null
  const rows = flattenSidebarTree(nodes)
  const rowRects = rows
    .filter((row) => !(row.id === active.id && row.kind === active.kind))
    .map((row) => {
      const dndId = sidebarDndId(row.kind, row.id)
      const escapedId = globalThis.CSS?.escape ? globalThis.CSS.escape(dndId) : dndId.replace(/"/g, '\\"')
      const element = document.querySelector<HTMLElement>(`[data-sidebar-dnd-id="${escapedId}"]`)
      return element ? { row, dndId, rect: element.getBoundingClientRect() } : null
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .sort((a, b) => a.rect.top - b.rect.top)

  if (rowRects.length === 0) {
    return projectSidebarDropFromRows({ rows, nodes, activeDndId, overDndId: null, placement: 'after' })
  }

  let target = rowRects.find(({ rect }) => pointer.y >= rect.top && pointer.y <= rect.bottom) ?? null
  if (!target) {
    target = rowRects.reduce((best, current) => {
      const bestDistance = Math.abs(pointer.y - (best.rect.top + best.rect.height / 2))
      const currentDistance = Math.abs(pointer.y - (current.rect.top + current.rect.height / 2))
      return currentDistance < bestDistance ? current : best
    }, rowRects[0]!)
  }

  const relative = (pointer.y - target.rect.top) / Math.max(target.rect.height, 1)
  const visualLeft = target.rect.left + target.row.depth * 10
  const draggedLeft = dragPointerOffset ? pointer.x - dragPointerOffset.x : pointer.x
  const horizontalOutdentIntent = draggedLeft < visualLeft
  const horizontalFolderIntent = target.row.kind === 'folder' && draggedLeft > visualLeft + 24
  const placement: DropPlacement = target.row.kind === 'folder' && !horizontalOutdentIntent && (horizontalFolderIntent || (relative >= 0.28 && relative <= 0.72))
    ? 'inside'
    : relative < 0.5 ? 'before' : 'after'
  if (placement !== 'inside' && target.row.kind === 'workspace' && target.row.parentFolderId && pointer.x < visualLeft - 4) {
    const outdentDepth = Math.max(0, Math.floor((draggedLeft - target.rect.left) / 10))
    const ancestorId = target.row.ancestorFolderIds[Math.min(outdentDepth, target.row.ancestorFolderIds.length - 1)]
    if (ancestorId) {
      return projectSidebarDropFromRows({
        rows,
        nodes,
        activeDndId,
        overDndId: sidebarDndId('folder', ancestorId),
        placement,
      })
    }
    return projectSidebarDropFromRows({
      rows,
      nodes,
      activeDndId,
      overDndId: sidebarDndId('folder', target.row.parentFolderId),
      placement,
    })
  }
  return projectSidebarDropFromRows({ rows, nodes, activeDndId, overDndId: target.dndId, placement })
}

function projectionKey(projection: SidebarDropProjection | null): string | null {
  if (!projection) return null
  return [
    projection.activeKind,
    projection.activeId,
    projection.parentFolderId ?? '',
    projection.beforeNodeId ?? '',
    projection.placement,
    projection.overId ?? '',
  ].join('|')
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}

function clampSidebarWidth(width: number): number {
  return Math.min(WORKSPACE_SIDEBAR_MAX_WIDTH, Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH, Math.round(width)))
}

function readWorkspaceSidebarWidth(): number {
  try {
    const raw = readMigratedLocalStorage(WORKSPACE_SIDEBAR_WIDTH_KEY, LEGACY_WORKSPACE_SIDEBAR_WIDTH_KEY)
    const parsed = raw ? Number(raw) : 256
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : 256
  } catch {
    return 256
  }
}

function writeWorkspaceSidebarWidth(width: number) {
  try {
    window.localStorage.setItem(WORKSPACE_SIDEBAR_WIDTH_KEY, String(clampSidebarWidth(width)))
  } catch {
    // ignore disabled/quota storage
  }
}

function readWorkspaceChatsAt(workspaceId: string): number {
  try {
    const raw = readMigratedLocalStorage(WORKSPACE_CHAT_READ_KEY, LEGACY_WORKSPACE_CHAT_READ_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {}
    return typeof parsed[workspaceId] === 'number' ? parsed[workspaceId] : 0
  } catch {
    return 0
  }
}

function markWorkspaceChatsRead(workspaceId: string) {
  try {
    const raw = readMigratedLocalStorage(WORKSPACE_CHAT_READ_KEY, LEGACY_WORKSPACE_CHAT_READ_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {}
    parsed[workspaceId] = Date.now()
    window.localStorage.setItem(WORKSPACE_CHAT_READ_KEY, JSON.stringify(parsed))
  } catch {
    // ignore disabled/quota storage
  }
}

function readMigratedLocalStorage(key: string, legacyKey: string): string | null {
  const value = window.localStorage.getItem(key)
  if (value !== null) return value
  const legacyValue = window.localStorage.getItem(legacyKey)
  if (legacyValue === null) return null
  window.localStorage.setItem(key, legacyValue)
  return legacyValue
}

function WorkspaceAgentPane({
  collapsed,
  onToggleCollapsed,
  onSessionListChange,
  dispatchWorkspaceState,
  focused,
  closeActiveTabSignal,
  onFocusTabs,
  onOpenUniversalMenu,
}: {
  collapsed: boolean
  onToggleCollapsed: () => void
  onSessionListChange: (count: number) => void
  dispatchWorkspaceState: WorkspaceUiDispatch
  focused: boolean
  closeActiveTabSignal: number
  onFocusTabs: () => void
  onOpenUniversalMenu: () => void
}) {
  const ctx = useWorkspaceContext()
  const bootstrapStatus = useWorkspaceBootstrapStatus(ctx.workspace.id)
  const openPane = useWorkspaceOpenPane(dispatchWorkspaceState)
  if (collapsed) {
    return <AgentCollapsedRail onExpand={onToggleCollapsed} />
  }

  const collapseButton = (
    <button
      onClick={onToggleCollapsed}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-neutral-800 bg-neutral-950/90 text-neutral-500 shadow hover:bg-neutral-900 hover:text-neutral-300"
      title="Collapse agent chat (⌘I)"
    >
      <ChevronLeft className="h-3 w-3" aria-hidden="true" />
    </button>
  )
  const agentHeaderTrailing = (newChat: { openNewChat: () => Promise<void>; setSessionId: (id: string) => void; workspaceId?: string } | null) => (
    <div className="flex shrink-0 items-center gap-1">
      {newChat?.workspaceId && <NewSessionPopover workspaceId={newChat.workspaceId} onCreated={newChat.setSessionId} onOpenNewChat={newChat.openNewChat} />}
      {collapseButton}
    </div>
  )
  if (!ctx.localEnvTarget?.available) {
    return (
      <AgentPaneFrame onFocusTabs={onFocusTabs}>
        <AgentPlaceholder message={ctx.localEnvTarget?.unavailableReason ?? 'Local env unavailable'} trailing={collapseButton} />
      </AgentPaneFrame>
    )
  }
  if (!ctx.localEnvTarget.token) {
    return (
      <AgentPaneFrame onFocusTabs={onFocusTabs}>
        <AgentPlaceholder message="Local env token unavailable" trailing={collapseButton} />
      </AgentPaneFrame>
    )
  }
  if (bootstrapStatus) {
    return (
      <AgentPaneFrame onFocusTabs={onFocusTabs}>
        <AgentPlaceholder message={bootstrapStatus.error ? `Workspace setup failed: ${bootstrapStatus.message}` : bootstrapStatus.message} trailing={collapseButton} />
      </AgentPaneFrame>
    )
  }
  return (
    <AgentPaneFrame onFocusTabs={onFocusTabs}>
      <WorkspaceAgentEnvProvider>
        <AgentSessionView
          workspaceId={ctx.workspace.id}
          activeSessionId={ctx.uiState.activeAgentSessionId}
          onSessionSelect={(sessionId) => dispatchWorkspaceState({ type: 'setActiveAgentSession', sessionId })}
          onActiveSessionChange={(sessionId) => dispatchWorkspaceState({ type: 'setActiveAgentSession', sessionId })}
          onSessionListChange={onSessionListChange}
          onOpenPane={openPane}
          onOpenPaneRefreshHint={() => undefined}
          headerTrailing={agentHeaderTrailing}
          tabsFocused={focused}
          closeActiveTabSignal={closeActiveTabSignal}
          onOpenNewChat={async () => {
            onOpenUniversalMenu()
            return null
          }}
        />
      </WorkspaceAgentEnvProvider>
    </AgentPaneFrame>
  )
}

function AgentPaneFrame({ children, onFocusTabs }: { children: ReactNode; onFocusTabs: () => void }) {
  return (
    <section
      className="relative flex h-full min-h-0 w-full flex-col bg-neutral-975"
      aria-label="Agent Chats"
      onPointerDownCapture={onFocusTabs}
      onFocusCapture={onFocusTabs}
    >
      {children}
    </section>
  )
}

function AgentCollapsedRail({ onExpand }: { onExpand: () => void }) {
  return (
    <button
      onClick={onExpand}
      title="Expand agent chat (⌘I)"
      className="flex h-full w-7 shrink-0 flex-col items-center justify-start gap-2 border-r border-neutral-800 bg-neutral-975 py-3 text-[10px] uppercase tracking-wider text-neutral-500 hover:bg-neutral-950 hover:text-neutral-300"
    >
      <span style={{ writingMode: 'vertical-rl' }}>Agent chat</span>
    </button>
  )
}

function useWorkspaceOpenPane(dispatchWorkspaceState: WorkspaceUiDispatch) {
  const ctx = useWorkspaceContext()
  return useCallback(
    (content: PaneContent, options?: { title?: string; activate?: boolean }) => {
      const envId = ctx.localEnvTarget?.env.id
      if (!envId && content.type !== 'browser') return
      const tab = workspaceTabFromPaneContent(content, envId, options)
      if (!tab) return
      dispatchWorkspaceState({
        type: 'openTab',
        tab,
        activate: options?.activate,
      })
    },
    [ctx.localEnvTarget?.env.id, dispatchWorkspaceState],
  )
}

function WorkspaceEnvTargetProvider({ children }: { children: ReactNode }) {
  const ctx = useWorkspaceContext()
  if (!ctx.localEnvTarget?.available || !ctx.localEnvTarget.token) return null
  return <WorkspaceAgentEnvProvider>{children}</WorkspaceAgentEnvProvider>
}

function WorkspaceAgentEnvProvider({ children }: { children: ReactNode }) {
  const ctx = useWorkspaceContext()
  const target = ctx.localEnvTarget
  const resources = useMemo(
    () => (target?.token ? getWorkspaceEnvResources(target) : null),
    [target?.env.id, target?.env.url, target?.token],
  )
  const queryClient = resources?.queryClient ?? null
  const client = resources?.managedClient.client ?? null

  if (!target?.token || !client || !queryClient) return <>{children}</>
  return (
    <envTrpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <EnvContextProvider
          value={{
            env: {
              id: target.env.id,
              kind: target.env.kind,
              url: target.env.url,
              label: target.env.label,
            },
            envToken: target.token,
          }}
        >
          {children}
        </EnvContextProvider>
      </QueryClientProvider>
    </envTrpc.Provider>
  )
}

function AgentPlaceholder({ message = 'Start a new agent chat', trailing }: { message?: string; trailing?: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-500">
        <button className="rounded border border-neutral-800 px-2 py-1 text-neutral-400">+ chat</button>
        {trailing}
      </div>
      <div className="flex flex-1 items-center justify-center text-neutral-500">{message}</div>
    </div>
  )
}

function WorkspaceTabPane({
  dispatchWorkspaceState,
  focused,
  onFocusTabs,
}: {
  dispatchWorkspaceState: WorkspaceUiDispatch
  focused: boolean
  onFocusTabs: () => void
}) {
  const ctx = useWorkspaceContext()
  const tabsRef = useRef(ctx.uiState.workspaceTabs)
  const [fileEditorStates, setFileEditorStates] = useState<Record<string, FileEditorState>>({})
  const [liveFaviconDataUrls, setLiveFaviconDataUrls] = useState<Record<string, string>>({})
  const pendingFaviconWritesRef = useRef(new Set<string>())
  const bookmarksStore = useBookmarksStore()
  const faviconOrigins = useMemo(() => Array.from(new Set(
    ctx.uiState.workspaceTabs
      .filter((tab): tab is Extract<WorkspaceTab, { type: 'browser' }> => tab.type === 'browser')
      .map((tab) => faviconOriginForUrl(tab.url))
      .filter((origin): origin is string => Boolean(origin)),
  )), [ctx.uiState.workspaceTabs])
  const faviconCache = trpc.favicon.getByOrigins.useQuery(
    { origins: faviconOrigins },
    { enabled: faviconOrigins.length > 0, staleTime: 60_000 },
  )
  const upsertFavicon = trpc.favicon.cacheFromUrl.useMutation()

  tabsRef.current = ctx.uiState.workspaceTabs

  useEffect(() => {
    return browserApi.onWindowTabCreated((event) => {
      if (event.presentation === 'popup') return
      if (!event.openerBrowserTabId) return
      const openedFromThisWorkspace = tabsRef.current.some(
        (tab) => tab.type === 'browser' && tab.browserTabId === event.openerBrowserTabId,
      )
      if (!openedFromThisWorkspace) return
      dispatchWorkspaceState({
        type: 'openTab',
        tab: {
          id: makeWorkspaceTabId('browser'),
          type: 'browser',
          url: event.url,
          browserTabId: event.browserTabId,
          title: truncateTabTitle(event.title || event.url),
        },
        activate: true,
      })
    })
  }, [dispatchWorkspaceState])

  const activeTab =
    ctx.uiState.workspaceTabs.find((tab) => tab.id === ctx.uiState.activeWorkspaceTabId) ??
    ctx.uiState.workspaceTabs[0]
  const unavailableReason = activeTab
    ? unavailableReasonForWorkspaceTab(activeTab, ctx.envTargets)
    : null
  const tabItems: BorderedTabItem[] = ctx.uiState.workspaceTabs.map((tab) => ({
    id: tab.id,
    label: tab.title,
    icon: tab.type === 'browser'
      ? browserTabIconForUrl({
        url: tab.url,
        records: (faviconCache.data ?? {}) as Record<string, FaviconCacheRecord>,
        liveDataUrls: liveFaviconDataUrls,
      })
      : paneTabIconForType(tab.type),
    title: workspaceTabLabel(tab),
  }))

  async function handleBrowserFaviconChange(input: { pageUrl: string; faviconUrl: string }) {
    const origin = faviconOriginForUrl(input.pageUrl)
    if (!origin) return
    const key = `${origin}:${input.faviconUrl}`
    if (pendingFaviconWritesRef.current.has(key)) return
    pendingFaviconWritesRef.current.add(key)
    try {
      const record = await upsertFavicon.mutateAsync({ pageOrigin: origin, iconUrl: input.faviconUrl })
      setLiveFaviconDataUrls((current) => ({ ...current, [origin]: record.dataUrl }))
      void faviconCache.refetch()
    } catch (error) {
      console.info('Favicon cache update failed', error)
    } finally {
      pendingFaviconWritesRef.current.delete(key)
    }
  }
  const canUseEnvTabs = Boolean(ctx.localEnvTarget?.available && ctx.localEnvTarget.token)
  return (
    <section
      className="flex h-full min-h-0 w-full flex-col bg-neutral-975"
      aria-label="Workspace Tabs"
      onPointerDownCapture={onFocusTabs}
      onFocusCapture={onFocusTabs}
    >
      <WorkspaceEnvTargetProvider>
        <WorkspaceShellTabTitleSync tabs={ctx.uiState.workspaceTabs} dispatchWorkspaceState={dispatchWorkspaceState} />
      </WorkspaceEnvTargetProvider>
      <div className="flex flex-none basis-8 items-stretch border-b border-neutral-800 bg-neutral-975">
        {canUseEnvTabs ? (
          <WorkspaceEnvTargetProvider>
            <WorkspaceShellTabStrip
              items={tabItems}
              tabs={ctx.uiState.workspaceTabs}
              activeId={ctx.uiState.activeWorkspaceTabId}
              workspaceId={ctx.workspace.id}
              dispatchWorkspaceState={dispatchWorkspaceState}
              focused={focused}
            />
          </WorkspaceEnvTargetProvider>
        ) : (
          <BorderedTabStrip
            items={tabItems}
            activeId={ctx.uiState.activeWorkspaceTabId}
            onSelect={(tabId) => dispatchWorkspaceState({ type: 'activateTab', tabId })}
            onClose={(tabId) => {
              const tab = ctx.uiState.workspaceTabs.find((candidate) => candidate.id === tabId)
              if (tab) closeWorkspaceTab(tab, dispatchWorkspaceState)
            }}
            onResort={(tabIds) => dispatchWorkspaceState({ type: 'reorderTabs', tabIds })}
            focused={focused}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden text-neutral-500">
        {unavailableReason ? (
          <div className="flex h-full items-center justify-center">
            <div className="rounded border border-amber-900 bg-amber-950/30 px-3 py-2 text-sm text-amber-300">
              {unavailableReason}
            </div>
          </div>
        ) : activeTab ? (
          <WorkspaceTabContent
            key={`${ctx.workspace.id}:${activeTab.id}`}
            tab={activeTab}
            onClose={() => closeWorkspaceTab(activeTab, dispatchWorkspaceState)}
            fileEditorState={activeTab.type === 'file' ? (fileEditorStates[activeTab.id] ?? emptyFileEditorState) : undefined}
            onFileEditorStateChange={(editorState) => {
              if (activeTab.type !== 'file') return
              setFileEditorStates((states) => updateFileEditorStateForTab(states, activeTab.id, editorState))
            }}
            onBrowserTabId={(browserTabId) =>
              dispatchWorkspaceState({ type: 'setBrowserTabId', tabId: activeTab.id, browserTabId })
            }
            onUrlChange={(url) =>
              dispatchWorkspaceState({ type: 'setTabUrl', tabId: activeTab.id, url })
            }
            onTitleChange={(title) =>
              dispatchWorkspaceState({ type: 'setTabTitle', tabId: activeTab.id, title: truncateTabTitle(title) })
            }
            onFaviconChange={(input) => void handleBrowserFaviconChange(input)}
            onNativeFocus={onFocusTabs}
            bookmarks={bookmarksStore.bookmarks}
            faviconDataUrl={activeTab.type === 'browser'
              ? (liveFaviconDataUrls[faviconOriginForUrl(activeTab.url) ?? ''] ?? ((faviconCache.data ?? {}) as Record<string, FaviconCacheRecord>)[faviconOriginForUrl(activeTab.url) ?? '']?.dataUrl ?? null)
              : null}
            faviconUrl={activeTab.type === 'browser'
              ? (((faviconCache.data ?? {}) as Record<string, FaviconCacheRecord>)[faviconOriginForUrl(activeTab.url) ?? '']?.iconUrl ?? null)
              : null}
          />
        ) : (
          <div className="flex h-full items-center justify-center">Workspace tabs</div>
        )}
      </div>
    </section>
  )
}

function WorkspaceShellTabStrip({
  items,
  tabs,
  activeId,
  workspaceId,
  dispatchWorkspaceState,
  focused,
}: {
  items: BorderedTabItem[]
  tabs: WorkspaceTab[]
  activeId: string | null
  workspaceId: string
  dispatchWorkspaceState: WorkspaceUiDispatch
  focused: boolean
}) {
  const queryClient = useQueryClient()
  const disposeShell = envTrpc.shell.dispose.useMutation()
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null)
  const contextTab = contextMenu ? tabs.find((tab) => tab.id === contextMenu.tabId) : undefined

  return (
    <div className="relative flex min-w-0 flex-1" onClick={() => setContextMenu(null)}>
      <BorderedTabStrip
        items={items}
        activeId={activeId}
        onSelect={(tabId) => dispatchWorkspaceState({ type: 'activateTab', tabId })}
        onClose={(tabId) => {
          const tab = tabs.find((candidate) => candidate.id === tabId)
          if (tab) closeWorkspaceTab(tab, dispatchWorkspaceState)
        }}
        onContextMenu={(tabId, event) => {
          const tab = tabs.find((candidate) => candidate.id === tabId)
          if (tab?.type !== 'shell') return
          event.preventDefault()
          setContextMenu({ tabId, x: event.clientX, y: event.clientY })
        }}
        onResort={(tabIds) => dispatchWorkspaceState({ type: 'reorderTabs', tabIds })}
        focused={focused}
      />
      {contextMenu && contextTab?.type === 'shell' && (
        <>
          <button
            className="fixed inset-0 z-40 cursor-default"
            aria-label="Close tab menu"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="fixed z-50 w-44 rounded border border-neutral-800 bg-neutral-975 shadow-lg"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            role="menu"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              onClick={() => {
                void (async () => {
                  await disposeShell.mutateAsync({ id: contextTab.shellId })
                  await queryClient.invalidateQueries({ queryKey: trpcQueryKey('shell.list', { workspaceId }) })
                  closeWorkspaceTab(contextTab, dispatchWorkspaceState)
                  setContextMenu(null)
                })()
              }}
              disabled={disposeShell.isPending}
              className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-900 disabled:opacity-50"
              role="menuitem"
            >
              Terminate shell
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function WorkspaceShellTabTitleSync({
  tabs,
  dispatchWorkspaceState,
}: {
  tabs: WorkspaceTab[]
  dispatchWorkspaceState: WorkspaceUiDispatch
}) {
  const ctx = useWorkspaceContext()
  const shells = envTrpc.shell.list.useQuery({ workspaceId: ctx.workspace.id }, { refetchInterval: 5_000 })

  useEffect(() => {
    if (!shells.data) return
    const liveShells = (shells.data as Array<{ id: string; alive?: boolean; title?: string | null }>).filter((shell) => shell.alive !== false)
    for (const tab of tabs) {
      if (tab.type === 'shell' && !isPendingShellTab(tab) && shells.data.some((shell) => shell.id === tab.shellId && shell.alive === false)) closeWorkspaceTab(tab, dispatchWorkspaceState)
    }

    const shellTitles = new Map(liveShells.map((shell) => [shell.id, shell.title?.trim() || `shell ${shell.id.slice(-8)}`]))
    for (const tab of tabs) {
      if (tab.type !== 'shell' || isPendingShellTab(tab) || tab.titleSource === 'explicit') continue
      const title = shellTitles.get(tab.shellId)
      if (title && title !== tab.title) dispatchWorkspaceState({ type: 'setTabAutoTitle', tabId: tab.id, title })
    }
  }, [dispatchWorkspaceState, shells.data, tabs])

  return null
}

function workspaceTabLabel(tab: WorkspaceTab): string {
  if (isPendingShellTab(tab)) return 'Starting shell…'
  if (tab.type === 'shell') return `shell ${tab.shellId}`
  if (tab.type === 'file') return tab.path
  return tab.url
}

function WorkspaceTabContent({
  tab,
  workspaceId,
  onClose,
  fileEditorState,
  onFileEditorStateChange,
  onBrowserTabId,
  onUrlChange,
  onTitleChange,
  onFaviconChange,
  onNativeFocus,
  bookmarks,
  faviconDataUrl,
  faviconUrl,
}: {
  tab: WorkspaceTab
  workspaceId?: string
  onClose: () => void
  fileEditorState?: FileEditorState
  onFileEditorStateChange?: (editorState: FileEditorState) => void
  onBrowserTabId: (browserTabId: string) => void
  onUrlChange: (url: string) => void
  onTitleChange: (title: string) => void
  onFaviconChange: (input: { pageUrl: string; faviconUrl: string }) => void
  onNativeFocus?: () => void
  bookmarks?: import('./workspace/bookmarks-store').BookmarkRecord[]
  faviconDataUrl?: string | null
  faviconUrl?: string | null
}) {
  const ctx = useWorkspaceContext()
  const contentWorkspaceId = workspaceId ?? ctx.workspace.id
  if (tab.type === 'shell') {
    if (isPendingShellTab(tab)) {
      return (
        <div className="flex h-full min-h-0 w-full items-center justify-center bg-neutral-975 text-sm text-neutral-500">
          Starting shell…
        </div>
      )
    }
    return (
      <div className="h-full min-h-0 w-full">
        <WorkspaceEnvTargetProvider>
          <ShellTabContent shellId={tab.shellId} workspaceId={contentWorkspaceId} />
        </WorkspaceEnvTargetProvider>
      </div>
    )
  }
  if (tab.type === 'file') {
    return (
      <div className="h-full min-h-0 w-full">
        <WorkspaceEnvTargetProvider>
          <FileTabContent
            path={tab.path}
            absolute
            editorState={fileEditorState}
            onEditorStateChange={onFileEditorStateChange}
          />
        </WorkspaceEnvTargetProvider>
      </div>
    )
  }
  return (
    <div className="h-full min-h-0 w-full">
        <BrowserTabContent
          paneId={tab.id}
          workspaceId={contentWorkspaceId}
        url={tab.url}
        title={tab.title}
        browserTabId={tab.browserTabId}
        faviconDataUrl={faviconDataUrl}
        faviconUrl={faviconUrl}
        bookmarks={bookmarks}
        active
        onBrowserTabId={onBrowserTabId}
        onUrlChange={onUrlChange}
        onTitleChange={onTitleChange}
        onFaviconChange={onFaviconChange}
        onNativeFocus={onNativeFocus}
        closeOnUnmount={false}
      />
    </div>
  )
}

type CloseWorkspaceTabTarget = WorkspaceUiDispatch | {
  type: 'closeTab'
  closeTab: (tabId: string) => void
  onActiveTabClosed?: () => void
}

function closeWorkspaceTab(tab: WorkspaceTab, target: CloseWorkspaceTabTarget): void {
  if (tab.type === 'browser' && tab.browserTabId && browserApi.isAvailable()) {
    void browserApi.closeTab({ browserTabId: tab.browserTabId })
  }
  if (typeof target === 'function') {
    target({ type: 'closeTab', tabId: tab.id })
  } else {
    target.closeTab(tab.id)
    target.onActiveTabClosed?.()
  }
}

function truncateTabTitle(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) return 'Browser'
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed
}

function WorkspaceError({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-neutral-950 p-8 text-neutral-100">
      <div className="text-red-400">{message}</div>
      <div className="mt-4">
        <Link to="/" className="text-neutral-200 hover:underline">
          Back to workspace
        </Link>
      </div>
    </div>
  )
}
