import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronLeft, ChevronRight, FolderPlus, Plus, Settings, X } from 'lucide-react'
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
import { browserApi } from '../lib/browser-api'
import { openCommandPaletteOverlay, openConfirmOverlay, openNewAgentChatOverlay, openTextInputOverlay, prewarmOverlayLayer } from '../lib/overlay-layer-controller'
import { extractTrpcMessage } from '../lib/utils'
import { BorderedTabStrip, type BorderedTabItem } from '../components/bordered-tab-strip'
import { ShellChrome } from './env/shell/shell-chrome'
import { EnvContextProvider } from './env/env-context'
import { AgentSessionView } from './env/agent/session-view'
import { ShellsDropdown } from './env/shell/dropdowns'
import { NewSessionPopover } from './env/agent/session-tabs'
import { NewAgentChatModal } from './env/agent/new-agent-chat-modal'
import { emptyFileEditorState, type FileEditorState } from './env/file-editor-state'
import { ShellTabContent } from './env/tabs/shell-tab'
import { FileTabContent } from './env/tabs/file-tab'
import { BrowserTabContent } from './env/tabs/browser-tab'
import { PreviewTabContent } from './env/tabs/preview-tab'
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
import { useWorkspaceViewStateStore } from './workspace/view-state-store'
import {
  type WorkspaceTab,
  type WorkspaceUiAction,
  type WorkspaceUiState,
  updateFileEditorStateForTab,
} from './workspace/tab-state'
import { useWorkspaceTabsStore } from './workspace/tabs-store'
import { useWorkspaceResourcesStore, type WorkspaceResourceRecord } from './workspace/resources-store'
import { idleRenameEditState, nextRenameValue, renameEditReducer } from './workspace/tab-bar-state'
import { makeWorkspaceTabId, workspaceTabFromPaneContent } from './workspace/open-pane'
import { workspaceRollupGlyph, workspaceRollupState } from './workspace/sidebar-rollup-state'
import { useAgentNotificationsStore, type AgentNotificationRecord } from './workspace/notifications-store'
import { createWorkspaceResourceCleanupRegistry, type CleanupResourceRow } from './workspace/resource-cleanup'
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

type WorkspaceUiDispatch = (action: WorkspaceUiAction) => void

type WorkspaceSummary = {
  id: string
  name: string
  folderId?: string | null
  position?: number
}

type WorkspaceFolderSummary = {
  id: string
  parentId?: string | null
  name: string
  position: number
  collapsed: boolean
}

type WorkspaceSidebarNode =
  | { type: 'folder'; folder: WorkspaceFolderSummary; children: WorkspaceSidebarNode[] }
  | { type: 'workspace'; workspace: WorkspaceSummary }

const WORKSPACE_SIDEBAR_WIDTH_KEY = 'cloud-code.workspaceSidebarWidth'
const WORKSPACE_SIDEBAR_MIN_WIDTH = 208
const WORKSPACE_SIDEBAR_MAX_WIDTH = 420
const WORKSPACE_CHAT_READ_KEY = 'cloud-code.workspaceChatReadAt'

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
  const navigate = useNavigate({ from: '/w/$workspaceId' })
  const queryClient = useQueryClient()
  const workspace = trpc.workspace.get.useQuery({ id: workspaceId })
  const envs = trpc.env.list.useQuery({}, { refetchInterval: 10_000 })
  const markOpened = trpc.workspace.markOpened.useMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.list') }),
  })
  const upsertResource = trpc.workspace.upsertResource.useMutation()
  const viewStateStore = useWorkspaceViewStateStore(workspaceId)
  const tabsStore = useWorkspaceTabsStore(workspaceId)
  const appliedSearchWorkspaceId = useRef<string | null>(null)

  useEffect(() => {
    if (workspace.data?.id) markOpened.mutate({ id: workspace.data.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.data?.id])

  useEffect(() => {
    if (!workspace.data || workspace.data.id !== workspaceId || !viewStateStore.viewState) return
    if (appliedSearchWorkspaceId.current !== workspaceId) {
      appliedSearchWorkspaceId.current = workspaceId
      if (search.chat && search.chat !== viewStateStore.viewState.activeAgentSessionId) {
        viewStateStore.setActiveAgentSession(search.chat)
      }
      if (
        search.tab &&
        search.tab !== viewStateStore.viewState.activeWorkspaceTabId &&
        tabsStore.tabs.some((tab) => tab.id === search.tab)
      ) {
        viewStateStore.setActiveWorkspaceTab(search.tab)
      }
      return
    }
    if (
      viewStateStore.viewState.activeWorkspaceTabId &&
      !tabsStore.tabs.some((tab) => tab.id === viewStateStore.viewState?.activeWorkspaceTabId)
    ) {
      viewStateStore.setActiveWorkspaceTab(tabsStore.tabs[0]?.id ?? null)
      return
    }
    if (
      viewStateStore.viewState.activeWorkspaceTabId !== (search.tab ?? null) ||
      viewStateStore.viewState.activeAgentSessionId !== (search.chat ?? null)
    ) {
      void navigate({
        search: (prev) => ({
          ...prev,
          chat: viewStateStore.viewState?.activeAgentSessionId ?? undefined,
          tab: viewStateStore.viewState?.activeWorkspaceTabId ?? undefined,
        }),
        replace: true,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.chat, search.tab, tabsStore.tabs, viewStateStore.viewState, workspace.data?.id, workspaceId])

  const dispatchSyncedWorkspaceState = useCallback<WorkspaceUiDispatch>((action) => {
    if (action.type === 'setActiveAgentSession') {
      viewStateStore.setActiveAgentSession(action.sessionId)
    } else if (action.type === 'activateTab') {
      viewStateStore.setActiveWorkspaceTab(action.tabId)
    } else if (action.type === 'openTab' && action.activate !== false) {
      const tab = tabsStore.openTab(action.tab, true)
      viewStateStore.setActiveWorkspaceTab(tab.id)
    } else if (action.type === 'openTab') {
      tabsStore.openTab(action.tab, false)
    } else if (action.type === 'closeTab') {
      const idx = tabsStore.tabs.findIndex((tab) => tab.id === action.tabId)
      if (idx !== -1 && viewStateStore.viewState?.activeWorkspaceTabId === action.tabId) {
        const tabs = tabsStore.tabs.filter((tab) => tab.id !== action.tabId)
        viewStateStore.setActiveWorkspaceTab(tabs[idx]?.id ?? tabs[idx - 1]?.id ?? null)
      }
      tabsStore.closeTab(action.tabId)
    } else if (action.type === 'setBrowserTabId') {
      tabsStore.setBrowserTabId(action.tabId, action.browserTabId)
      const tab = tabsStore.tabs.find((candidate) => candidate.id === action.tabId)
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
      tabsStore.setTabUrl(action.tabId, action.url)
    } else if (action.type === 'setTabTitle') {
      tabsStore.setTabTitle(action.tabId, action.title)
    } else if (action.type === 'setSplitRatio') {
      viewStateStore.setSplitRatio(action.splitRatio)
    } else if (action.type === 'setAgentCollapsed') {
      viewStateStore.setAgentCollapsed(action.collapsed)
    }
  }, [tabsStore, upsertResource, viewStateStore, workspaceId])

  const envTargets = useMemo(() => {
    return ((envs.data ?? []) as WorkspaceEnvRow[]).map(resolveWorkspaceEnvTarget)
  }, [envs.data])
  const localEnvTarget = useMemo(() => selectLocalEnvTarget(envTargets), [envTargets])
  const getEnvClient = useMemo(
    () => createWorkspaceEnvClientResolver(envTargets),
    [envTargets],
  )

  const initiallyLoading =
    (workspace.isLoading && !workspace.data) ||
    (envs.isLoading && !envs.data) ||
    (viewStateStore.isLoading && !viewStateStore.viewState) ||
    (tabsStore.isLoading && !tabsStore.data)

  if (initiallyLoading) {
    return <div className="p-8 text-neutral-500">Loading workspace…</div>
  }
  if (workspace.error) return <WorkspaceError message={extractTrpcMessage(workspace.error)} />
  if (envs.error) return <WorkspaceError message={extractTrpcMessage(envs.error)} />
  if (viewStateStore.isError) return <WorkspaceError message="Workspace view state did not load." />
  if (tabsStore.isError) return <WorkspaceError message="Workspace tabs did not load." />
  if (!workspace.data) {
    return <WorkspaceError message="Workspace did not load." />
  }
  if (!viewStateStore.viewState || !tabsStore.data) {
    return <div className="p-8 text-neutral-500">Loading workspace…</div>
  }

  const syncedWorkspaceState: WorkspaceUiState = {
    workspaceTabs: tabsStore.tabs,
    activeAgentSessionId: viewStateStore.viewState.activeAgentSessionId,
    activeWorkspaceTabId: viewStateStore.viewState.activeWorkspaceTabId,
    splitRatio: viewStateStore.viewState.splitRatio,
    agentCollapsed: viewStateStore.viewState.agentCollapsed,
    tabOrder: tabsStore.tabs.map((tab) => tab.id),
  }

  return (
    <WorkspaceContextProvider
      value={{
        workspace: workspace.data,
        uiState: syncedWorkspaceState,
        envTargets,
        localEnvTarget,
        getEnvClient,
      }}
    >
      <WorkspaceShell key={workspace.data.id} dispatchWorkspaceState={dispatchSyncedWorkspaceState} />
    </WorkspaceContextProvider>
  )
}

function WorkspaceShell({
  dispatchWorkspaceState,
}: {
  dispatchWorkspaceState: WorkspaceUiDispatch
}) {
  const ctx = useWorkspaceContext()
  const [sidebarHidden, setSidebarHidden] = useState(false)
  const [agentSessionCount, setAgentSessionCount] = useState(0)
  const agentCollapsed = ctx.uiState.agentCollapsed
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
      if (agentSessionCount === 0) setAgentCollapsed(true)
    },
    [agentSessionCount, openWorkspacePane, setAgentCollapsed],
  )
  const closeActiveTab = useCallback(() => {
    const activeTab = ctx.uiState.workspaceTabs.find((tab) => tab.id === ctx.uiState.activeWorkspaceTabId)
    if (activeTab) closeWorkspaceTab(activeTab, dispatchWorkspaceState)
  }, [ctx.uiState.activeWorkspaceTabId, ctx.uiState.workspaceTabs, dispatchWorkspaceState])
  const openCommandPalette = useCallback(async () => {
    const target = ctx.localEnvTarget
    if (!target?.available || !target.token) return
    const result = await openCommandPaletteOverlay({
      env: target.env,
      envToken: target.token,
      workspaceId: ctx.workspace.id,
      activeSessionId: ctx.uiState.activeAgentSessionId,
      hasActiveTab: ctx.uiState.workspaceTabs.length > 0,
    })
    if (result.type === 'open-pane') openPane(result.content)
    if (result.type === 'close-tab') closeActiveTab()
  }, [closeActiveTab, ctx.localEnvTarget, ctx.uiState.activeAgentSessionId, ctx.uiState.workspaceTabs.length, ctx.workspace.id, openPane])

  useEffect(() => {
    prewarmOverlayLayer()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        void openCommandPalette()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setSidebarHidden((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
        e.preventDefault()
        setAgentCollapsed(!agentCollapsed)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [agentCollapsed, openCommandPalette, setAgentCollapsed])

  return (
    <div className="flex h-screen max-h-screen w-screen overflow-hidden bg-neutral-975 text-neutral-100">
      {!sidebarHidden && (
        <WorkspaceSidebar
          dispatchWorkspaceState={dispatchWorkspaceState}
          onHide={() => setSidebarHidden(true)}
        />
      )}
      <ShellChrome
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
          />
        }
        right={
          ctx.uiState.workspaceTabs.length > 0 ? (
            <WorkspaceTabPane dispatchWorkspaceState={dispatchWorkspaceState} />
          ) : (
            <WorkspaceEmptyPaneCta onOpenPalette={() => void openCommandPalette()} />
          )
        }
      />
    </div>
  )
}

function WorkspaceEmptyPaneCta({ onOpenPalette }: { onOpenPalette: () => void }) {
  return (
    <section className="flex h-full min-h-0 w-full items-center justify-center bg-neutral-975 p-8" aria-label="Workspace empty pane">
      <button
        type="button"
        onClick={onOpenPalette}
        className="group flex items-center gap-3 text-xs text-neutral-600 transition-colors hover:text-neutral-300"
      >
        <span>Open a shell, file, preview, or browser pane</span>
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
}: {
  dispatchWorkspaceState: WorkspaceUiDispatch
  onHide: () => void
}) {
  const ctx = useWorkspaceContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const tree = trpc.workspace.listTree.useQuery(undefined, { refetchInterval: 15_000 })
  const list = trpc.workspace.list.useQuery(undefined, { refetchInterval: 15_000 })
  const resourcesStore = useWorkspaceResourcesStore()
  const createFolder = trpc.workspace.createFolder.useMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.listTree') }),
  })
  const rename = trpc.workspace.rename.useMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.list') })
      queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.listTree') })
    },
  })
  const archive = trpc.workspace.archive.useMutation({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.list') })
      queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.listTree') })
    },
  })
  const deleteResource = trpc.workspace.deleteResource.useMutation()
  const setFolderCollapsed = trpc.workspace.setFolderCollapsed.useMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.listTree') }),
  })
  const archiveFolder = trpc.workspace.archiveFolder.useMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.listTree') }),
  })
  const moveSidebarNode = trpc.workspace.moveSidebarNode.useMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.listTree') }),
    onError: () => queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.listTree') }),
  })
  const [edit, dispatchEdit] = useReducer(renameEditReducer, idleRenameEditState)
  const [newChatContext, setNewChatContext] = useState<null | { mode: 'new'; folderId?: string | null } | { mode: 'existing'; workspace: WorkspaceSummary }>(null)
  const [cleanupWorkspace, setCleanupWorkspace] = useState<WorkspaceSummary | null>(null)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [dragPlacement, setDragPlacement] = useState<DropPlacement>('after')
  const [dropProjection, setDropProjection] = useState<SidebarDropProjection | null>(null)
  const [localTree, setLocalTree] = useState<WorkspaceSidebarNode[] | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => readWorkspaceSidebarWidth())
  const [chatReadVersion, setChatReadVersion] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
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
      await rename.mutateAsync({ id: edit.editingId, name: nextName })
    }
    dispatchEdit({ type: 'saved' })
  }

  async function closeWorkspace(workspaceId: string, workspaces: WorkspaceSummary[]) {
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
    await archive.mutateAsync({ id: workspaceId })
    for (const resource of resourcesStore.records.filter((record) => record.workspaceId === workspaceId)) {
      await deleteResource.mutateAsync({ id: resource.id }).catch(() => undefined)
    }
  }

  const workspaces = (list.data ?? []) as WorkspaceSummary[]
  const nodes = (tree.data ?? []) as WorkspaceSidebarNode[]
  const displayNodes = localTree ?? nodes
  const workspaceNames = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])), [workspaces])
  const dndNodes = displayNodes as unknown as SidebarTreeNode[]
  const flatRows = flattenSidebarTree(dndNodes)
  const sortableIds = flatRows.map((row) => sidebarDndId(row.kind, row.id))
  const sortingStrategy = dropProjection?.placement === 'inside' ? noSortingDisplacementStrategy : verticalListSortingStrategy
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  async function openFolderCreate(parentId: string | null) {
    const name = await openTextInputOverlay({
      title: 'New workspace folder',
      message: 'Create a folder for organizing project workspaces.',
      label: 'Folder name',
      confirmLabel: 'Create folder',
    })
    if (!name) return
    await createFolder.mutateAsync({ name, parentId })
  }

  async function deleteFolder(folder: WorkspaceFolderSummary) {
    const node = findSidebarFolderNode(displayNodes, folder.id)
    const workspaceCount = node ? countWorkspacesInSidebarNodes(node.children) : 0
    if (workspaceCount > 0) {
      const confirmed = await openConfirmOverlay({
        title: 'Delete workspace folder?',
        message: `${folder.name} contains ${workspaceCount} workspace${workspaceCount === 1 ? '' : 's'}. Deleting it will also delete all child workspaces and folders.`,
        confirmLabel: 'Delete folder',
        destructive: true,
      })
      if (!confirmed) return
    }
    await archiveFolder.mutateAsync({ id: folder.id })
  }

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
      setFolderCollapsed.mutate({ id: parsed.id, collapsed: true })
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
    queryClient.setQueryData(trpcQueryKey('workspace.listTree'), optimisticTree)
    setActiveDragId(null)
    setDropProjection(null)
    lastPointerRef.current = null
    dragPointerOffsetRef.current = null
    lastProjectionRef.current = null
    lastProjectionKeyRef.current = null
    try {
      const serverTree = await moveSidebarNode.mutateAsync({
        nodeType: projection.activeKind,
        nodeId: projection.activeId,
        parentFolderId: projection.parentFolderId,
        beforeNodeId: projection.beforeNodeId,
      })
      queryClient.setQueryData(trpcQueryKey('workspace.listTree'), serverTree)
    } catch (err) {
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.listTree') })
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
        className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize bg-transparent hover:bg-brand-500/40"
        aria-hidden="true"
      />
      <div className="window-drag flex flex-none basis-8 items-center justify-between gap-2 border-b border-neutral-800 bg-neutral-950 px-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-neutral-300">cloud code</div>
        </div>
        <div className="flex items-center">
          <button
            onClick={() => setNewChatContext({ mode: 'new', folderId: null })}
            className="rounded px-0.5 py-0.5 text-neutral-600 hover:bg-neutral-900 hover:text-neutral-200 disabled:opacity-50"
            aria-label="Create new workspace from chat"
            title="New workspace from chat"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button
            onClick={() => void openFolderCreate(null)}
            disabled={createFolder.isPending}
            className="rounded px-0.5 py-0.5 text-neutral-600 hover:bg-neutral-900 hover:text-neutral-200 disabled:opacity-50"
            aria-label="Create workspace folder"
            title="New folder"
          >
            <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
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
          className="flex items-center gap-2 rounded px-[3px] py-1 text-xs text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-neutral-200"
        >
          <Settings className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate font-medium">Settings</span>
        </Link>
      </div>
      {ctx.localEnvTarget?.available && ctx.localEnvTarget.token && newChatContext && (
        <WorkspaceAgentEnvProvider>
          <NewAgentChatModal
            open
            workspaceId={newChatContext.mode === 'existing' ? newChatContext.workspace.id : ctx.workspace.id}
            workspaceName={newChatContext.mode === 'existing' ? newChatContext.workspace.name : ctx.workspace.name}
            initialWorkspaceMode={newChatContext.mode}
            folderId={newChatContext.mode === 'new' ? newChatContext.folderId : undefined}
            onClose={() => setNewChatContext(null)}
            onCreated={(sessionId, workspaceId) => void selectCreatedChat(sessionId, workspaceId)}
          />
        </WorkspaceAgentEnvProvider>
      )}
      {cleanupWorkspace && (
        <WorkspaceAgentEnvProvider>
          <WorkspaceCleanupModal
            workspace={cleanupWorkspace}
            allWorkspaces={workspaces}
            resources={resourcesStore.records}
            onCancel={() => setCleanupWorkspace(null)}
            onArchive={async () => {
              await closeWorkspace(cleanupWorkspace.id, workspaces)
              setCleanupWorkspace(null)
            }}
          />
        </WorkspaceAgentEnvProvider>
      )}
    </aside>
    </>
  )

  function renderSidebarRow(row: FlatSidebarNode): ReactNode {
    if (row.kind === 'folder') {
      const folder = findSidebarFolder(displayNodes, row.id)
      if (!folder) return null
      const dndId = sidebarDndId('folder', folder.id)
      const folderHasVisibleChildren = !folder.collapsed && flatRows.some((candidate) => candidate.ancestorFolderIds.includes(folder.id))
      return (
        <SortableSidebarRow
          key={dndId}
          id={dndId}
          depth={row.depth}
          active={activeDragId === dndId}
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
                onClick={() => setFolderCollapsed.mutate({ id: folder.id, collapsed: !folder.collapsed })}
                className="-ml-0.5 flex h-4 w-3 shrink-0 items-center justify-center rounded text-neutral-500 hover:text-neutral-300"
                aria-label={`${folder.collapsed ? 'Expand' : 'Collapse'} folder ${folder.name}`}
              >
                {folder.collapsed ? <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
              </button>
              <div className={
                'flex min-w-0 flex-1 items-center rounded px-1.5 py-0.5 group-hover:bg-neutral-900 group-hover:text-neutral-200 ' +
                (dropProjection?.overId === folder.id && dropProjection.placement === 'inside' ? 'bg-brand-500/10 text-neutral-100 ring-1 ring-brand-400/60 shadow-[0_0_0_3px_rgba(56,189,248,0.10)]' : '')
              }
              onClick={() => setFolderCollapsed.mutate({ id: folder.id, collapsed: !folder.collapsed })}>
                <span className="min-w-0 flex-1 truncate px-0.5 font-medium" title={folder.name}>{folder.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setNewChatContext({ mode: 'new', folderId: folder.id })
                  }}
                  className="rounded px-0.5 py-0.5 text-neutral-600 opacity-0 hover:text-neutral-200 group-hover:opacity-100"
                  aria-label={`Create workspace in ${folder.name}`}
                  title="New workspace from chat"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void openFolderCreate(folder.id)
                  }}
                  disabled={createFolder.isPending}
                  className="rounded px-0.5 py-0.5 text-neutral-600 opacity-0 hover:text-neutral-200 disabled:opacity-30 group-hover:opacity-100"
                  aria-label={`Create folder in ${folder.name}`}
                  title="New folder"
                >
                  <FolderPlus className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    void deleteFolder(folder)
                  }}
                  disabled={archiveFolder.isPending}
                  className="rounded px-0.5 py-0.5 text-neutral-600 opacity-0 hover:text-neutral-200 disabled:opacity-30 group-hover:opacity-100"
                  aria-label={`Delete folder ${folder.name}`}
                  title="Delete folder"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </SortableSidebarRow>
      )
    }
    const workspace = findSidebarWorkspace(displayNodes, row.id)
    if (!workspace) return null
    const dndId = sidebarDndId('workspace', workspace.id)
    const editing = edit.editingId === workspace.id
    const active = workspace.id === ctx.workspace.id
    const showChatRollup = Boolean(ctx.localEnvTarget?.available && ctx.localEnvTarget.token)
    return (
      <SortableSidebarRow
        key={dndId}
        id={dndId}
        depth={row.depth}
        active={activeDragId === dndId}
        guideDepths={row.ancestorFolderIds.map((_, index) => index)}
      >
        <div className="relative mb-0.5">
          <div className="group flex items-center gap-px text-neutral-400">
            <span className="h-4 w-1 shrink-0" aria-hidden="true" />
            <div className={
              'relative flex min-w-0 flex-1 items-center rounded px-1.5 py-0.5 transition-colors group-hover:bg-neutral-900 group-hover:text-neutral-200 ' +
              (active ? 'bg-neutral-900 text-neutral-100' : 'text-neutral-400')
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
                  className="min-w-0 flex-1 rounded border border-brand-500 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 outline-none"
                  aria-label="Workspace name"
                />
              ) : (
                <Link
                  to="/w/$workspaceId"
                  params={{ workspaceId: workspace.id }}
                  search={{ chat: undefined, tab: undefined }}
                  onDoubleClick={(e) => {
                    e.preventDefault()
                    dispatchEdit({ type: 'begin', workspaceId: workspace.id, name: workspace.name })
                  }}
                  className="min-w-0 flex-1 truncate rounded px-0.5 py-0.5 text-left text-xs font-medium"
                  title={workspace.name}
                >
                  {workspace.name}
                </Link>
              )}
              {showChatRollup && (
                <span className="pointer-events-none absolute right-1.5 flex items-center transition-transform duration-150 group-hover:-translate-x-10">
                  <WorkspaceAgentEnvProvider>
                    <WorkspaceSidebarChatCount workspaceId={workspace.id} readVersion={chatReadVersion} />
                  </WorkspaceAgentEnvProvider>
                </span>
              )}
              <button
                onClick={() => setNewChatContext({ mode: 'existing', workspace })}
                className="rounded px-0.5 py-0.5 text-neutral-600 opacity-0 hover:text-neutral-200 group-hover:opacity-100"
                aria-label={`Create chat in ${workspace.name}`}
                title="New chat in workspace"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setCleanupWorkspace(workspace)
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

function WorkspaceCleanupModal({
  workspace,
  allWorkspaces,
  resources,
  onCancel,
  onArchive,
}: {
  workspace: WorkspaceSummary
  allWorkspaces: WorkspaceSummary[]
  resources: WorkspaceResourceRecord[]
  onCancel: () => void
  onArchive: () => Promise<void>
}) {
  const envUtils = envTrpc.useUtils()
  const { mutateAsync: disposeShellAsync } = envTrpc.shell.dispose.useMutation()
  const { mutateAsync: deleteWorktreeAsync } = envTrpc.repo.deleteWorktree.useMutation()
  const [cleanupRows, setCleanupRows] = useState<CleanupResourceRow[]>([])
  const [loadingResources, setLoadingResources] = useState(true)
  const [selectedCleanupIds, setSelectedCleanupIds] = useState<Set<string>>(() => new Set())
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const resourcesRef = useRef(resources)
  const envUtilsRef = useRef(envUtils)
  const disposeShellAsyncRef = useRef(disposeShellAsync)
  const deleteWorktreeAsyncRef = useRef(deleteWorktreeAsync)
  resourcesRef.current = resources
  envUtilsRef.current = envUtils
  disposeShellAsyncRef.current = disposeShellAsync
  deleteWorktreeAsyncRef.current = deleteWorktreeAsync
  const workspaceResources = useMemo(() => resources.filter((resource) => resource.workspaceId === workspace.id), [resources, workspace.id])
  const workspaceResourceSignature = workspaceResources.map((resource) => `${resource.id}:${resource.type}:${resource.resourceKey}:${resource.shared}:${JSON.stringify(resource.data)}`).join('\0')
  const listShells = useCallback(() => envUtilsRef.current.shell.list.fetch({ workspaceId: workspace.id }) as Promise<Array<{ id: string }>>, [workspace.id])
  const cleanupShell = useCallback((id: string) => disposeShellAsyncRef.current({ id }), [])
  const listWorktrees = useCallback(() => envUtilsRef.current.repo.listWorktrees.fetch() as Promise<Array<{ id: string; workingDir: string }>>, [])
  const cleanupWorktree = useCallback((repoId: string) => deleteWorktreeAsyncRef.current({ repoId }), [])
  const makeCleanupRegistry = useCallback(() => createWorkspaceResourceCleanupRegistry({
    workspaceId: workspace.id,
    resources: resourcesRef.current,
    listShells,
    disposeShell: cleanupShell,
    listWorktrees,
    deleteWorktree: cleanupWorktree,
  }), [cleanupShell, cleanupWorktree, listShells, listWorktrees, workspace.id])

  useEffect(() => {
    let cancelled = false
    async function loadRows() {
      setLoadingResources(true)
      try {
        const next: CleanupResourceRow[] = []
        const seen = new Set<string>()
        const registry = makeCleanupRegistry()
        const currentWorkspaceResources = resourcesRef.current.filter((resource) => resource.workspaceId === workspace.id)
        for (const resource of currentWorkspaceResources) {
          const handler = registry.handlerFor(resource.type)
          if (!await handler.exists(resource)) continue
          const row = handler.row(resource)
          if (seen.has(row.id)) continue
          seen.add(row.id)
          next.push(row)
        }
        if (!cancelled) setCleanupRows(next)
      } finally {
        if (!cancelled) setLoadingResources(false)
      }
    }
    void loadRows()
    return () => {
      cancelled = true
    }
  }, [makeCleanupRegistry, workspace.id, workspaceResourceSignature])

  const cleanupableIds = cleanupRows.filter((row) => row.canCleanup).map((row) => row.id)

  useEffect(() => {
    setSelectedCleanupIds((current) => current.size === 0 ? new Set(cleanupableIds) : current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cleanupableIds.join('\0')])

  function toggleCleanup(resourceId: string) {
    setSelectedCleanupIds((current) => {
      const next = new Set(current)
      if (next.has(resourceId)) next.delete(resourceId)
      else next.add(resourceId)
      return next
    })
  }

  async function cleanResources(resourceIds: Set<string>) {
    const registry = makeCleanupRegistry()
    const currentWorkspaceResources = resourcesRef.current.filter((resource) => resource.workspaceId === workspace.id)
    await Promise.all(currentWorkspaceResources.map(async (resource) => {
      if (!resourceIds.has(resource.id)) return
      const handler = registry.handlerFor(resource.type)
      if (!await handler.exists(resource)) return
      const row = handler.row(resource)
      if (!row.canCleanup) return
      await handler.cleanup(resource)
    }))
  }

  async function archiveWithCleanup() {
    setErr(null)
    setBusy(true)
    try {
      await cleanResources(selectedCleanupIds)
      await onArchive()
    } catch (error) {
      setErr(extractTrpcMessage(error))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl">
        <div className="border-b border-neutral-800 px-4 py-3">
          <div className="text-sm font-medium text-neutral-100">Archive workspace?</div>
          <div className="mt-1 text-xs text-neutral-500">{workspace.name}</div>
        </div>
        <div className="space-y-3 px-4 py-3 text-xs text-neutral-300">
          <p>Select resources to clean up before archiving.</p>
          <div>
            <div className="flex items-center justify-between border-b border-neutral-850 px-2 py-1.5 text-[11px] text-neutral-500">
              <span>{cleanupRows.length} resource{cleanupRows.length === 1 ? '' : 's'}</span>
              <span>{selectedCleanupIds.size} selected</span>
            </div>
            <div className="max-h-64 divide-y divide-neutral-900 overflow-y-auto">
              {cleanupRows.length === 0 ? (
                <div className="px-3 py-6 text-center text-neutral-600">No tracked resources.</div>
              ) : cleanupRows.map((row) => (
                <label key={row.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-neutral-900/60">
                  <input
                    type="checkbox"
                    checked={selectedCleanupIds.has(row.id)}
                    disabled={!row.canCleanup || busy}
                    onChange={() => toggleCleanup(row.id)}
                    className="h-3 w-3 shrink-0 accent-brand-500 disabled:opacity-40"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="shrink-0 rounded bg-neutral-900 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-neutral-500">{row.type}</span>
                      <span className="truncate font-mono text-[11px] text-neutral-200">{row.label}</span>
                    </div>
                    {row.detail && <div className="truncate text-[10px] text-neutral-600">{row.detail}</div>}
                  </div>
                  {row.shared && <span className="shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-amber-200">shared</span>}
                  {row.shared && (
                    <span className={(row.orphan ? 'border-amber-500/30 bg-amber-500/10 text-amber-200' : 'border-neutral-700 bg-neutral-900 text-neutral-500') + ' shrink-0 rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wide'}>
                      {row.orphan ? 'orphan' : 'in use'}
                    </span>
                  )}
                </label>
              ))}
            </div>
          </div>
          {allWorkspaces.length <= 1 && <div className="text-neutral-500">This is the last active workspace.</div>}
          {err && <div className="rounded border border-red-900 bg-red-950/50 px-2 py-1 text-red-300">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-neutral-800 px-4 py-3">
          <button type="button" onClick={onCancel} disabled={busy} className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-60">Cancel</button>
          <button type="button" onClick={() => void archiveWithCleanup()} disabled={busy || loadingResources} className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-60">
            {busy ? 'Archiving…' : 'Archive and cleanup'}
          </button>
        </div>
      </div>
    </div>
  )
}

function WorkspaceSidebarChatCount({ workspaceId, readVersion: _readVersion }: { workspaceId: string; readVersion: number }) {
  const summary = envTrpc.agent.workspaceChatSummary.useQuery({ workspaceIds: [workspaceId] }, { refetchInterval: 5_000 })
  const row = (summary.data ?? [])[0]
  if (!row) return null
  const latestActivityAt = row.latestActivityAt ? new Date(row.latestActivityAt).getTime() : 0
  const readAt = readWorkspaceChatsAt(workspaceId)
  const newResponseCount = row.runningCount === 0 && readAt > 0 && latestActivityAt > readAt ? 1 : 0
  const glyph = workspaceRollupGlyph(workspaceRollupState({
    chatCount: row.chatCount,
    runningCount: row.runningCount,
    pendingAttentionCount: row.pendingAttentionCount,
    newResponseCount,
  }))
  if (row.chatCount <= 1 && !glyph) return null
  return (
    <span className="flex shrink-0 items-center gap-1">
      {row.chatCount > 1 && <span className="rounded bg-neutral-900 px-1.5 py-0.5 text-[10px] text-neutral-500">{row.chatCount}</span>}
      {glyph === '.' && <span className="h-1 w-1 rounded-full bg-brand-500" aria-label="New chat response" />}
      {glyph === '*' && <span className="h-2.5 w-2.5 animate-spin rounded-full border border-brand-400 border-t-transparent" aria-label="Chat running" />}
      {glyph === '!' && <span className="w-3 text-center text-[10px] font-semibold text-amber-300" aria-label="Chat needs attention">!</span>}
    </span>
  )
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
  const activeNotificationIds = notifications.records
    .filter((notification) => notification.sessionId === activeSessionId)
    .map((notification) => notification.id)
    .join('\0')
  const rows = notifications.records.filter((notification) => notification.sessionId !== activeSessionId)

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
          const railClass = notificationRailClass(notification.kind)
          return (
            <div
              key={notification.id}
              className="group relative flex cursor-pointer items-start gap-1 px-2 py-1.5"
            >
              <span className={`absolute inset-y-0 right-0 w-0.5 ${railClass}`} aria-hidden="true" />
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

function notificationRailClass(kind: AgentNotificationRecord['kind']): string {
  if (kind === 'permission') return 'bg-amber-400'
  if (kind === 'question') return 'bg-violet-400'
  if (kind === 'error') return 'bg-red-400'
  return 'bg-brand-500'
}

const sidebarAnimateLayoutChanges: AnimateLayoutChanges = (args) =>
  defaultAnimateLayoutChanges({ ...args, wasDragging: true })

const noSortingDisplacementStrategy: SortingStrategy = () => null

function SortableSidebarRow({
  id,
  active,
  depth,
  guideDepths = [],
  children,
}: {
  id: string
  active: boolean
  depth: number
  guideDepths?: number[]
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    animateLayoutChanges: sidebarAnimateLayoutChanges,
    transition: {
      duration: 240,
      easing: 'cubic-bezier(0.25, 1, 0.5, 1)',
    },
  })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      data-sidebar-dnd-id={id}
      className={
        'relative will-change-transform ' +
        (active || isDragging ? 'opacity-30' : '')
      }
      style={{
        paddingLeft: depth * 8,
        cursor: active ? 'grabbing' : 'grab',
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

function findSidebarFolder(nodes: WorkspaceSidebarNode[], id: string): WorkspaceFolderSummary | null {
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    if (node.folder.id === id) return node.folder
    const child = findSidebarFolder(node.children, id)
    if (child) return child
  }
  return null
}

function findSidebarFolderNode(nodes: WorkspaceSidebarNode[], id: string): Extract<WorkspaceSidebarNode, { type: 'folder' }> | null {
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    if (node.folder.id === id) return node
    const child = findSidebarFolderNode(node.children, id)
    if (child) return child
  }
  return null
}

function countWorkspacesInSidebarNodes(nodes: WorkspaceSidebarNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.type === 'workspace') count++
    else count += countWorkspacesInSidebarNodes(node.children)
  }
  return count
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

function clampSidebarWidth(width: number): number {
  return Math.min(WORKSPACE_SIDEBAR_MAX_WIDTH, Math.max(WORKSPACE_SIDEBAR_MIN_WIDTH, Math.round(width)))
}

function readWorkspaceSidebarWidth(): number {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_SIDEBAR_WIDTH_KEY)
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
    const raw = window.localStorage.getItem(WORKSPACE_CHAT_READ_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {}
    return typeof parsed[workspaceId] === 'number' ? parsed[workspaceId] : 0
  } catch {
    return 0
  }
}

function markWorkspaceChatsRead(workspaceId: string) {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_CHAT_READ_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, number>) : {}
    parsed[workspaceId] = Date.now()
    window.localStorage.setItem(WORKSPACE_CHAT_READ_KEY, JSON.stringify(parsed))
  } catch {
    // ignore disabled/quota storage
  }
}

function WorkspaceAgentPane({
  collapsed,
  onToggleCollapsed,
  onSessionListChange,
  dispatchWorkspaceState,
}: {
  collapsed: boolean
  onToggleCollapsed: () => void
  onSessionListChange: (count: number) => void
  dispatchWorkspaceState: WorkspaceUiDispatch
}) {
  const ctx = useWorkspaceContext()
  const queryClient = useQueryClient()
  const openPane = useWorkspaceOpenPane(dispatchWorkspaceState)
  const refreshWorkspacePanes = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['sync', 'workspace_tabs'] })
    void queryClient.invalidateQueries({ queryKey: ['workspace-view-state', ctx.workspace.id] })
  }, [ctx.workspace.id, queryClient])
  if (collapsed) {
    return <AgentCollapsedRail onExpand={onToggleCollapsed} />
  }

  const collapseButton = (
    <button
      onClick={onToggleCollapsed}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-neutral-800 bg-neutral-950/90 text-neutral-500 shadow hover:bg-neutral-900 hover:text-neutral-300"
      title="Collapse agent chat (⌘G)"
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
  const agentFooterTrailing = (
    <WorkspaceEnvTargetProvider>
      <ShellsDropdown align="right" side="top" workspaceId={ctx.workspace.id} onOpen={(content) => openPane(content)} />
    </WorkspaceEnvTargetProvider>
  )

  if (!ctx.localEnvTarget?.available) {
    return (
      <AgentPaneFrame>
        <AgentPlaceholder message={ctx.localEnvTarget?.unavailableReason ?? 'Local env unavailable'} trailing={collapseButton} />
      </AgentPaneFrame>
    )
  }
  if (!ctx.localEnvTarget.token) {
    return (
      <AgentPaneFrame>
        <AgentPlaceholder message="Local env token unavailable" trailing={collapseButton} />
      </AgentPaneFrame>
    )
  }
  const localEnvTarget = ctx.localEnvTarget
  const localEnvToken = localEnvTarget.token!
  return (
    <AgentPaneFrame>
      <WorkspaceAgentEnvProvider>
        <AgentSessionView
          workspaceId={ctx.workspace.id}
          activeSessionId={ctx.uiState.activeAgentSessionId}
          onSessionSelect={(sessionId) => dispatchWorkspaceState({ type: 'setActiveAgentSession', sessionId })}
          onActiveSessionChange={(sessionId) => dispatchWorkspaceState({ type: 'setActiveAgentSession', sessionId })}
          onSessionListChange={onSessionListChange}
          onOpenPane={openPane}
          onOpenPaneRefreshHint={refreshWorkspacePanes}
          headerTrailing={agentHeaderTrailing}
          footerTrailing={agentFooterTrailing}
          onOpenNewChat={() =>
            openNewAgentChatOverlay({
              workspaceId: ctx.workspace.id,
              env: localEnvTarget.env,
              envToken: localEnvToken,
            })
          }
        />
      </WorkspaceAgentEnvProvider>
    </AgentPaneFrame>
  )
}

function AgentPaneFrame({ children }: { children: ReactNode }) {
  return (
    <section className="relative flex h-full min-h-0 w-full flex-col bg-neutral-975" aria-label="Agent Chats">
      {children}
    </section>
  )
}

function AgentCollapsedRail({ onExpand }: { onExpand: () => void }) {
  return (
    <button
      onClick={onExpand}
      title="Expand agent chat (⌘G)"
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
}: {
  dispatchWorkspaceState: WorkspaceUiDispatch
}) {
  const ctx = useWorkspaceContext()
  const tabsRef = useRef(ctx.uiState.workspaceTabs)
  const [fileEditorStates, setFileEditorStates] = useState<Record<string, FileEditorState>>({})

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
    title: workspaceTabLabel(tab),
  }))
  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-neutral-975" aria-label="Workspace Tabs">
      <div className="flex flex-none basis-8 items-stretch border-b border-neutral-800 bg-neutral-975">
        <BorderedTabStrip
          items={tabItems}
          activeId={ctx.uiState.activeWorkspaceTabId}
          onSelect={(tabId) => dispatchWorkspaceState({ type: 'activateTab', tabId })}
          onClose={(tabId) => {
            const tab = ctx.uiState.workspaceTabs.find((candidate) => candidate.id === tabId)
            if (tab) closeWorkspaceTab(tab, dispatchWorkspaceState)
          }}
        />
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
          />
        ) : (
          <div className="flex h-full items-center justify-center">Workspace tabs</div>
        )}
      </div>
    </section>
  )
}

function workspaceTabLabel(tab: WorkspaceTab): string {
  if (tab.type === 'shell') return `shell ${tab.shellId}`
  if (tab.type === 'file') return tab.path
  if (tab.type === 'preview') return `preview :${tab.port}`
  return tab.url
}

function WorkspaceTabContent({
  tab,
  onClose,
  fileEditorState,
  onFileEditorStateChange,
  onBrowserTabId,
  onUrlChange,
  onTitleChange,
}: {
  tab: WorkspaceTab
  onClose: () => void
  fileEditorState?: FileEditorState
  onFileEditorStateChange?: (editorState: FileEditorState) => void
  onBrowserTabId: (browserTabId: string) => void
  onUrlChange: (url: string) => void
  onTitleChange: (title: string) => void
}) {
  const ctx = useWorkspaceContext()
  if (tab.type === 'shell') {
    return (
      <div className="h-full min-h-0 w-full">
        <WorkspaceEnvTargetProvider>
          <ShellTabContent shellId={tab.shellId} workspaceId={ctx.workspace.id} onTerminated={onClose} />
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
  if (tab.type === 'browser') {
    return (
      <div className="h-full min-h-0 w-full">
        <BrowserTabContent
          paneId={tab.id}
          url={tab.url}
          browserTabId={tab.browserTabId}
          active
          onBrowserTabId={onBrowserTabId}
          onUrlChange={onUrlChange}
          onTitleChange={onTitleChange}
          closeOnUnmount={false}
        />
      </div>
    )
  }
  return (
    <div className="h-full min-h-0 w-full">
      <WorkspaceEnvTargetProvider>
        <PreviewTabContent port={tab.port} />
      </WorkspaceEnvTargetProvider>
    </div>
  )
}

function closeWorkspaceTab(tab: WorkspaceTab, dispatchWorkspaceState: WorkspaceUiDispatch): void {
  if (tab.type === 'browser' && tab.browserTabId && browserApi.isAvailable()) {
    void browserApi.closeTab({ browserTabId: tab.browserTabId })
  }
  dispatchWorkspaceState({ type: 'closeTab', tabId: tab.id })
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
        <Link to="/" className="text-brand-500 hover:underline">
          Back to workspace
        </Link>
      </div>
    </div>
  )
}
