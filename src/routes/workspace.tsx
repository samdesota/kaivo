import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { trpc } from '../trpc'
import { envTrpc, makeEnvReactClient } from '../env-trpc'
import { browserApi } from '../lib/browser-api'
import { openNewAgentChatOverlay, prewarmOverlayLayer } from '../lib/overlay-layer-controller'
import { extractTrpcMessage } from '../lib/utils'
import { ShellChrome } from './env/shell/shell-chrome'
import { EnvContextProvider } from './env/env-context'
import { AgentSessionView } from './env/agent/session-view'
import { CommandPalette } from './env/shell/command-palette'
import { ShellsDropdown } from './env/shell/dropdowns'
import { NewSessionPopover } from './env/agent/session-tabs'
import { useChatSession, useRetainChatSessions } from './env/agent/chat-state'
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
  type WorkspaceEnvRow,
} from './workspace/env-targets'
import { WorkspaceContextProvider, useWorkspaceContext } from './workspace/context'
import { useWorkspaceViewStateStore } from './workspace/view-state-store'
import {
  type WorkspaceTab,
  type WorkspaceUiAction,
  type WorkspaceUiState,
} from './workspace/tab-state'
import { useWorkspaceTabsStore } from './workspace/tabs-store'
import { orderWorkspaceTabs } from './workspace/workspace-tab-bar'
import { idleRenameEditState, nextRenameValue, renameEditReducer } from './workspace/tab-bar-state'
import { makeWorkspaceTabId, workspaceTabFromPaneContent } from './workspace/open-pane'
import { trpcQueryKey } from '../lib/trpc-plain'

type WorkspaceUiDispatch = (action: WorkspaceUiAction) => void

type WorkspaceSummary = {
  id: string
  name: string
}

type SessionSummary = {
  id: string
  workspaceId?: string | null
  title: string | null
  status: string
  createdAt: Date | string
  lastActivityAt: Date | string
}

const PENDING_WORKSPACE_RENAME_KEY = 'cloud-code.pendingWorkspaceRenameId'
const WORKSPACE_SIDEBAR_ORDER_KEY = 'cloud-code.workspaceTabOrder'

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
    } else if (action.type === 'setTabTitle') {
      tabsStore.setTabTitle(action.tabId, action.title)
    } else if (action.type === 'setSplitRatio') {
      viewStateStore.setSplitRatio(action.splitRatio)
    } else if (action.type === 'setAgentCollapsed') {
      viewStateStore.setAgentCollapsed(action.collapsed)
    }
  }, [tabsStore, viewStateStore])

  const envTargets = useMemo(() => {
    return ((envs.data ?? []) as WorkspaceEnvRow[]).map(resolveWorkspaceEnvTarget)
  }, [envs.data])
  const localEnvTarget = useMemo(() => selectLocalEnvTarget(envTargets), [envTargets])
  const getEnvClient = useMemo(
    () => createWorkspaceEnvClientResolver(envTargets),
    [envTargets],
  )

  if (workspace.isLoading || envs.isLoading || viewStateStore.isLoading || tabsStore.isLoading) {
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
      <WorkspaceShell dispatchWorkspaceState={dispatchSyncedWorkspaceState} />
    </WorkspaceContextProvider>
  )
}

function WorkspaceShell({
  dispatchWorkspaceState,
}: {
  dispatchWorkspaceState: WorkspaceUiDispatch
}) {
  const ctx = useWorkspaceContext()
  const [paletteOpen, setPaletteOpen] = useState(false)
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

  useEffect(() => {
    prewarmOverlayLayer()
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
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
  }, [agentCollapsed, setAgentCollapsed])

  return (
    <div className="flex h-screen bg-neutral-950 text-neutral-100">
      {!sidebarHidden && (
        <WorkspaceSidebar
          dispatchWorkspaceState={dispatchWorkspaceState}
          onHide={() => setSidebarHidden(true)}
        />
      )}
      <ShellChrome
        className="min-h-0 flex-1"
        title={ctx.workspace.name}
        subtitle={ctx.localEnvTarget ? `local · ${ctx.localEnvTarget.env.label}` : 'local env unavailable'}
        splitStorageKey={`workspace.${ctx.workspace.id}.splitRatio`}
        splitInitialRatio={ctx.uiState.splitRatio ?? 0.7}
        leftCollapsed={agentCollapsed}
        onSplitRatioChange={onSplitRatioChange}
        actions={
          <WorkspaceHeaderActions
            onCommandPalette={() => setPaletteOpen(true)}
            onOpenPane={openPane}
          />
        }
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
          ) : undefined
        }
      />
      <WorkspaceEnvTargetProvider>
        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onOpenContent={openPane}
          onCloseTab={closeActiveTab}
          hasActiveTab={ctx.uiState.workspaceTabs.length > 0}
          activeSessionId={ctx.uiState.activeAgentSessionId}
          workspaceId={ctx.workspace.id}
        />
      </WorkspaceEnvTargetProvider>
    </div>
  )
}

function WorkspaceSidebar({
  dispatchWorkspaceState,
  onHide,
}: {
  dispatchWorkspaceState: WorkspaceUiDispatch
  onHide: () => void
}) {
  const ctx = useWorkspaceContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const list = trpc.workspace.list.useQuery(undefined, { refetchInterval: 15_000 })
  const create = trpc.workspace.create.useMutation()
  const rename = trpc.workspace.rename.useMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.list') }),
  })
  const archive = trpc.workspace.archive.useMutation({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: trpcQueryKey('workspace.list') }),
  })
  const [edit, dispatchEdit] = useReducer(renameEditReducer, idleRenameEditState)
  const [optimisticWorkspace, setOptimisticWorkspace] = useState<WorkspaceSummary | null>(null)
  const [workspaceOrder, setWorkspaceOrder] = useState<string[]>(() => {
    try {
      const raw = window.localStorage.getItem(WORKSPACE_SIDEBAR_ORDER_KEY)
      return raw ? (JSON.parse(raw) as string[]) : []
    } catch {
      return []
    }
  })
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (edit.editingId) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [edit.editingId])

  useEffect(() => {
    const pending = window.sessionStorage.getItem(PENDING_WORKSPACE_RENAME_KEY)
    if (pending !== ctx.workspace.id) return
    window.sessionStorage.removeItem(PENDING_WORKSPACE_RENAME_KEY)
    dispatchEdit({ type: 'begin', workspaceId: ctx.workspace.id, name: ctx.workspace.name })
  }, [ctx.workspace.id, ctx.workspace.name])

  async function createWorkspace() {
    const workspace = await create.mutateAsync({})
    setOptimisticWorkspace({ id: workspace.id, name: workspace.name })
    window.sessionStorage.setItem(PENDING_WORKSPACE_RENAME_KEY, workspace.id)
    dispatchEdit({ type: 'begin', workspaceId: workspace.id, name: workspace.name })
    await navigate({
      to: '/w/$workspaceId',
      params: { workspaceId: workspace.id },
      search: { chat: undefined, tab: undefined },
    })
  }

  async function saveRename() {
    if (!edit.editingId) return
    const nextName = nextRenameValue(edit)
    if (nextName) {
      await rename.mutateAsync({ id: edit.editingId, name: nextName })
      setOptimisticWorkspace((workspace) =>
        workspace?.id === edit.editingId ? { ...workspace, name: nextName } : workspace,
      )
    }
    dispatchEdit({ type: 'saved' })
  }

  async function closeWorkspace(workspaceId: string, workspaces: WorkspaceSummary[]) {
    await archive.mutateAsync({ id: workspaceId })
    const remaining = workspaces.filter((workspace) => workspace.id !== workspaceId)
    const next = remaining[0]
    if (workspaceId === ctx.workspace.id) {
      if (next) {
        await navigate({
          to: '/w/$workspaceId',
          params: { workspaceId: next.id },
          search: { chat: undefined, tab: undefined },
        })
      } else {
        await createWorkspace()
      }
    }
  }

  const workspaces = useMemo(() => {
    const rows = [...((list.data ?? []) as WorkspaceSummary[])]
    if (optimisticWorkspace && !rows.some((workspace) => workspace.id === optimisticWorkspace.id)) {
      rows.push(optimisticWorkspace)
    }
    const ordered = orderWorkspaceTabs(rows, ctx.workspace, workspaceOrder)
    const nextOrder = ordered.map((workspace) => workspace.id)
    if (nextOrder.join('\0') !== workspaceOrder.join('\0')) {
      setWorkspaceOrder(nextOrder)
      try {
        window.localStorage.setItem(WORKSPACE_SIDEBAR_ORDER_KEY, JSON.stringify(nextOrder))
      } catch {
        // ignore disabled/quota storage
      }
    }
    return ordered
  }, [ctx.workspace, list.data, optimisticWorkspace, workspaceOrder])

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/95" aria-label="Workspaces">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">Cloud Code</div>
          <div className="truncate text-xs text-neutral-300">Workspaces</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void createWorkspace()}
            disabled={create.isPending}
            className="rounded px-2 py-1 text-sm leading-none text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100 disabled:opacity-50"
            aria-label="Create new workspace"
            title="New workspace"
          >
            +
          </button>
          <button
            onClick={onHide}
            className="rounded px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
            title="Hide sidebar (⌘B)"
          >
            ⌘B
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {workspaces.map((workspace) => {
          const active = workspace.id === ctx.workspace.id
          const editing = edit.editingId === workspace.id
          return (
            <div key={workspace.id} className="mb-2">
              <div className="group flex items-center gap-1">
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
                    className={
                      'min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-xs font-medium transition-colors ' +
                      (active ? 'bg-neutral-900 text-neutral-100' : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200')
                    }
                    title={workspace.name}
                  >
                    {workspace.name}
                  </Link>
                )}
                {ctx.localEnvTarget?.available && ctx.localEnvTarget.token && (
                  <WorkspaceAgentEnvProvider>
                    <WorkspaceSidebarNewChatButton
                      workspaceId={workspace.id}
                      onCreated={async (sessionId) => {
                        if (workspace.id === ctx.workspace.id) {
                          dispatchWorkspaceState({ type: 'setActiveAgentSession', sessionId })
                        }
                        await navigate({
                          to: '/w/$workspaceId',
                          params: { workspaceId: workspace.id },
                          search: { chat: sessionId, tab: undefined },
                        })
                      }}
                    />
                  </WorkspaceAgentEnvProvider>
                )}
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    void closeWorkspace(workspace.id, workspaces)
                  }}
                  className="rounded px-1 text-[11px] leading-none text-neutral-600 opacity-0 hover:bg-neutral-800 hover:text-neutral-200 group-hover:opacity-100"
                  aria-label={`Close workspace ${workspace.name}`}
                  title="Close workspace"
                >
                  ×
                </button>
              </div>
              {ctx.localEnvTarget?.available && ctx.localEnvTarget.token ? (
                <WorkspaceAgentEnvProvider>
                  <WorkspaceSidebarSessions
                    workspaceId={workspace.id}
                    activeWorkspaceId={ctx.workspace.id}
                    activeSessionId={ctx.uiState.activeAgentSessionId}
                    dispatchWorkspaceState={dispatchWorkspaceState}
                  />
                </WorkspaceAgentEnvProvider>
              ) : active ? (
                <div className="px-2 py-1.5 text-[11px] text-neutral-600">Agent unavailable</div>
              ) : null}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

function WorkspaceSidebarNewChatButton({
  workspaceId,
  onCreated,
}: {
  workspaceId: string
  onCreated: (sessionId: string) => void | Promise<void>
}) {
  const queryClient = useQueryClient()
  return (
    <div className="opacity-0 transition-opacity group-hover:opacity-100">
      <NewSessionPopover
        workspaceId={workspaceId}
        onCreated={async (sessionId) => {
          await queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionList', { workspaceId }) })
          await onCreated(sessionId)
        }}
        label="+"
      />
    </div>
  )
}

function WorkspaceSidebarSessions({
  workspaceId,
  activeWorkspaceId,
  activeSessionId,
  dispatchWorkspaceState,
}: {
  workspaceId: string
  activeWorkspaceId: string
  activeSessionId: string | null
  dispatchWorkspaceState: WorkspaceUiDispatch
}) {
  const navigate = useNavigate()
  const sessions = envTrpc.agent.sessionList.useQuery({ workspaceId }, { refetchInterval: 5_000 })
  const rows = useMemo(() => {
    return ((sessions.data ?? []) as SessionSummary[]).filter((session) => session.status !== 'archived')
  }, [sessions.data])
  const sessionIds = useMemo(() => rows.map((session) => session.id), [rows])
  useRetainChatSessions(sessionIds)

  async function selectSession(sessionId: string) {
    if (workspaceId === activeWorkspaceId) {
      dispatchWorkspaceState({ type: 'setActiveAgentSession', sessionId })
      await navigate({
        to: '/w/$workspaceId',
        params: { workspaceId },
        search: { chat: sessionId, tab: undefined },
      })
      return
    }
    await navigate({
      to: '/w/$workspaceId',
      params: { workspaceId },
      search: { chat: sessionId, tab: undefined },
    })
  }

  if (sessions.isLoading) {
    return <div className="px-2 py-1.5 text-[11px] text-neutral-600">Loading chats…</div>
  }

  return (
    <div className="mt-1 space-y-0.5 pl-2">
      {rows.length === 0 ? (
        <div className="px-2 py-1 text-[11px] text-neutral-600">No chats</div>
      ) : (
        rows.map((session) => (
          <WorkspaceSidebarSessionRow
            key={session.id}
            session={session}
            selected={workspaceId === activeWorkspaceId && session.id === activeSessionId}
            onSelect={() => void selectSession(session.id)}
          />
        ))
      )}
    </div>
  )
}

function WorkspaceSidebarSessionRow({
  session,
  selected,
  onSelect,
}: {
  session: SessionSummary
  selected: boolean
  onSelect: () => void
}) {
  const chat = useChatSession(session.id)
  const running = chat.running || Boolean(chat.status?.running)
  const [wasRunning, setWasRunning] = useState(running)
  const [unreadFinished, setUnreadFinished] = useState(false)
  const label = session.title ?? session.id.slice(-6)

  useEffect(() => {
    if (selected) setUnreadFinished(false)
  }, [selected])

  useEffect(() => {
    if (wasRunning && !running && !selected) setUnreadFinished(true)
    setWasRunning(running)
  }, [running, selected, wasRunning])

  return (
    <button
      onClick={onSelect}
      className={
        'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px] transition-colors ' +
        (selected ? 'bg-brand-500/15 text-neutral-100' : 'text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200')
      }
      title={`${label} · ${new Date(session.lastActivityAt).toLocaleString()}`}
    >
      <span className="flex h-3 w-3 shrink-0 items-center justify-center">
        {running ? (
          <span className="h-2.5 w-2.5 animate-spin rounded-full border border-brand-400 border-t-transparent" />
        ) : unreadFinished ? (
          <span className="h-2 w-2 rounded-full bg-brand-400" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-neutral-700" />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  )
}

function WorkspaceHeaderActions({
  onCommandPalette,
  onOpenPane,
}: {
  onCommandPalette: () => void
  onOpenPane: (content: PaneContent, options?: { title?: string; activate?: boolean }) => void
}) {
  const ctx = useWorkspaceContext()
  return (
    <>
      <button
        onClick={onCommandPalette}
        className="rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
      >
        ⌘K
      </button>
      <WorkspaceEnvTargetProvider>
        <ShellsDropdown align="right" workspaceId={ctx.workspace.id} onOpen={(content) => onOpenPane(content)} />
      </WorkspaceEnvTargetProvider>
      <EnvStatusLink />
      <Link to="/settings" className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200">
        Settings
      </Link>
    </>
  )
}

function EnvStatusLink() {
  const ctx = useWorkspaceContext()
  const label = ctx.localEnvTarget?.available ? ctx.localEnvTarget.env.label : 'Env unavailable'
  return (
    <Link to="/dashboard" className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200">
      {label}
    </Link>
  )
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
    void queryClient.invalidateQueries({ queryKey: ['workspace-tabs', ctx.workspace.id] })
    void queryClient.invalidateQueries({ queryKey: ['workspace-view-state', ctx.workspace.id] })
  }, [ctx.workspace.id, queryClient])
  if (collapsed) {
    return <AgentCollapsedRail onExpand={onToggleCollapsed} />
  }

  const collapseButton = (
    <button
      onClick={onToggleCollapsed}
      className="shrink-0 rounded border border-neutral-800 bg-neutral-950/90 px-1.5 py-0.5 text-[10px] uppercase text-neutral-500 shadow hover:bg-neutral-900 hover:text-neutral-300"
      title="Collapse agent chat (⌘G)"
    >
      ←
    </button>
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
          headerTrailing={collapseButton}
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
    <section className="relative flex h-full min-h-0 w-full flex-col" aria-label="Agent Chats">
      {children}
    </section>
  )
}

function AgentCollapsedRail({ onExpand }: { onExpand: () => void }) {
  return (
    <button
      onClick={onExpand}
      title="Expand agent chat (⌘G)"
      className="flex h-full w-7 shrink-0 flex-col items-center justify-start gap-2 border-r border-neutral-800 bg-neutral-950 py-3 text-[10px] uppercase tracking-wider text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
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
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [target?.env.id, target?.token],
  )
  const client = useMemo(() => {
    if (!target?.token) return null
    return makeEnvReactClient(target.env, target.token)
  }, [target?.env, target?.token])

  if (!target?.token || !client) return <>{children}</>
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

  tabsRef.current = ctx.uiState.workspaceTabs

  useEffect(() => {
    return browserApi.onWindowTabCreated((event) => {
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
  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-neutral-950" aria-label="Workspace Tabs">
      <div
        role="tablist"
        className="flex items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap border-b border-neutral-800 bg-neutral-950 px-2 py-1"
      >
        {ctx.uiState.workspaceTabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === ctx.uiState.activeWorkspaceTabId}
            className={
              'group flex shrink-0 items-center gap-0.5 rounded transition-colors ' +
              (tab.id === ctx.uiState.activeWorkspaceTabId
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200')
            }
          >
            <button
              onClick={() => dispatchWorkspaceState({ type: 'activateTab', tabId: tab.id })}
              className="max-w-[200px] truncate py-1 pl-2 pr-1 text-xs"
              title={workspaceTabLabel(tab)}
            >
              {tab.title}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                closeWorkspaceTab(tab, dispatchWorkspaceState)
              }}
              className="mr-1 rounded px-1 text-[11px] leading-none text-neutral-500 opacity-70 hover:bg-neutral-700 hover:text-neutral-100 hover:opacity-100"
              aria-label="Close tab"
              title="Close tab"
            >
              ×
            </button>
          </div>
        ))}
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
            tab={activeTab}
            onClose={() => closeWorkspaceTab(activeTab, dispatchWorkspaceState)}
            onBrowserTabId={(browserTabId) =>
              dispatchWorkspaceState({ type: 'setBrowserTabId', tabId: activeTab.id, browserTabId })
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
  onBrowserTabId,
  onTitleChange,
}: {
  tab: WorkspaceTab
  onClose: () => void
  onBrowserTabId: (browserTabId: string) => void
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
          <FileTabContent path={tab.path} absolute />
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
