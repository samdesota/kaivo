import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
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
import { ShellTabContent } from './env/tabs/shell-tab'
import { FileTabContent } from './env/tabs/file-tab'
import { BrowserTabContent } from './env/tabs/browser-tab'
import type { PaneContent } from './env/shell/tab-state'
import {
  createWorkspaceEnvClientResolver,
  unavailableReasonForWorkspaceTab,
  resolveWorkspaceEnvTarget,
  selectLocalEnvTarget,
  type WorkspaceEnvRow,
} from './workspace/env-targets'
import { WorkspaceContextProvider, useWorkspaceContext } from './workspace/context'
import {
  emptyWorkspaceUiState,
  workspaceUiReducer,
  type WorkspaceTab,
  type WorkspaceUiState,
} from './workspace/tab-state'
import { WorkspaceTabBar } from './workspace/workspace-tab-bar'

type WorkspaceUiDispatch = Dispatch<Parameters<typeof workspaceUiReducer>[1]>

export function WorkspacePage() {
  const { workspaceId } = useParams({ from: '/w/$workspaceId' })
  const search = useSearch({ from: '/w/$workspaceId' })
  const navigate = useNavigate({ from: '/w/$workspaceId' })
  const utils = trpc.useUtils()
  const workspace = trpc.workspace.get.useQuery({ id: workspaceId })
  const uiState = trpc.workspace.getUiState.useQuery({ workspaceId })
  const envs = trpc.env.list.useQuery({}, { refetchInterval: 10_000 })
  const markOpened = trpc.workspace.markOpened.useMutation({
    onSuccess: () => utils.workspace.list.invalidate(),
  })
  const saveUiState = trpc.workspace.saveUiState.useMutation()
  const [workspaceState, dispatchWorkspaceState] = useReducer(
    workspaceUiReducer,
    emptyWorkspaceUiState(),
  )
  const [hydrated, setHydrated] = useState(false)
  const [hydratedStateWorkspaceId, setHydratedStateWorkspaceId] = useState<string | null>(null)
  const hydratedWorkspaceId = useRef<string | null>(null)

  useEffect(() => {
    hydratedWorkspaceId.current = null
    setHydratedStateWorkspaceId(null)
    setHydrated(false)
    dispatchWorkspaceState({ type: 'hydrate', state: emptyWorkspaceUiState() })
  }, [workspaceId])

  useEffect(() => {
    if (workspace.data?.id) markOpened.mutate({ id: workspace.data.id })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.data?.id])

  useEffect(() => {
    if (!uiState.data) return
    if (hydratedWorkspaceId.current === workspaceId) return
    hydratedWorkspaceId.current = workspaceId
    dispatchWorkspaceState({
      type: 'hydrate',
      state: {
        ...(uiState.data as WorkspaceUiState),
        activeAgentSessionId: search.chat ?? uiState.data.activeAgentSessionId,
        activeWorkspaceTabId: search.tab ?? uiState.data.activeWorkspaceTabId,
      },
    })
    setHydratedStateWorkspaceId(workspaceId)
    setHydrated(true)
  }, [uiState.data, workspaceId, search.chat, search.tab])

  useEffect(() => {
    if (
      !workspace.data ||
      workspace.data.id !== workspaceId ||
      !hydrated ||
      hydratedWorkspaceId.current !== workspaceId ||
      hydratedStateWorkspaceId !== workspaceId
    ) {
      return
    }
    saveUiState.mutate({ workspaceId, state: workspaceState })
    if (workspaceState.activeWorkspaceTabId !== search.tab) {
      void navigate({
        search: (prev) => ({
          ...prev,
          chat: workspaceState.activeAgentSessionId ?? undefined,
          tab: workspaceState.activeWorkspaceTabId ?? undefined,
        }),
        replace: true,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceState, workspace.data?.id, workspaceId, hydrated, hydratedStateWorkspaceId])

  const envTargets = useMemo(() => {
    return ((envs.data ?? []) as WorkspaceEnvRow[]).map(resolveWorkspaceEnvTarget)
  }, [envs.data])
  const localEnvTarget = useMemo(() => selectLocalEnvTarget(envTargets), [envTargets])
  const getEnvClient = useMemo(
    () => createWorkspaceEnvClientResolver(envTargets),
    [envTargets],
  )

  if (workspace.isLoading || uiState.isLoading || envs.isLoading) {
    return <div className="p-8 text-neutral-500">Loading workspace…</div>
  }
  if (workspace.error) return <WorkspaceError message={extractTrpcMessage(workspace.error)} />
  if (uiState.error) return <WorkspaceError message={extractTrpcMessage(uiState.error)} />
  if (envs.error) return <WorkspaceError message={extractTrpcMessage(envs.error)} />
  if (!workspace.data || !uiState.data) {
    return <WorkspaceError message="Workspace did not load." />
  }
  if (!hydrated || hydratedStateWorkspaceId !== workspaceId) {
    return <div className="p-8 text-neutral-500">Loading workspace…</div>
  }

  return (
    <WorkspaceContextProvider
      value={{
        workspace: workspace.data,
        uiState: workspaceState,
        envTargets,
        localEnvTarget,
        getEnvClient,
      }}
    >
      <WorkspaceShell dispatchWorkspaceState={dispatchWorkspaceState} />
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
        setAgentCollapsed(!agentCollapsed)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [agentCollapsed, setAgentCollapsed])

  return (
    <div className="flex h-screen flex-col">
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
        />
      </WorkspaceEnvTargetProvider>
      <WorkspaceBottomBar />
    </div>
  )
}

function WorkspaceHeaderActions({
  onCommandPalette,
  onOpenPane,
}: {
  onCommandPalette: () => void
  onOpenPane: (content: PaneContent, options?: { title?: string; activate?: boolean }) => void
}) {
  return (
    <>
      <button
        onClick={onCommandPalette}
        className="rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
      >
        ⌘K
      </button>
      <WorkspaceEnvTargetProvider>
        <ShellsDropdown align="right" onOpen={(content) => onOpenPane(content)} />
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
  const openPane = useWorkspaceOpenPane(dispatchWorkspaceState)
  if (collapsed) {
    return <AgentCollapsedRail onExpand={onToggleCollapsed} />
  }

  const collapseButton = (
    <button
      onClick={onToggleCollapsed}
      className="shrink-0 rounded border border-neutral-800 bg-neutral-950/90 px-1.5 py-0.5 text-[10px] uppercase text-neutral-500 shadow hover:bg-neutral-900 hover:text-neutral-300"
      title="Collapse agent chat (⌘B)"
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
      title="Expand agent chat (⌘B)"
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
      const id = makeWorkspaceTabId(content.type, envId)
      if (content.type === 'shell') {
        dispatchWorkspaceState({
          type: 'openTab',
          tab: { id, type: 'shell', envId: envId!, shellId: content.shellId, title: options?.title ?? `shell ${content.shellId.slice(-8)}` },
          activate: options?.activate,
        })
      } else if (content.type === 'file') {
        dispatchWorkspaceState({
          type: 'openTab',
          tab: { id, type: 'file', envId: envId!, path: content.path, title: options?.title ?? content.path.split('/').pop() ?? content.path },
          activate: options?.activate,
        })
      } else if (content.type === 'browser') {
        if (!content.url) return
        dispatchWorkspaceState({
          type: 'openTab',
          tab: { id, type: 'browser', url: content.url, title: options?.title ?? content.url },
          activate: options?.activate,
        })
      }
    },
    [ctx.localEnvTarget?.env.id, dispatchWorkspaceState],
  )
}

function makeWorkspaceTabId(type: string, envId?: string): string {
  return `${type}-${envId ?? 'browser'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
  if (tab.type === 'shell') {
    return (
      <div className="h-full min-h-0 w-full">
        <WorkspaceEnvTargetProvider>
          <ShellTabContent shellId={tab.shellId} onTerminated={onClose} />
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
  return <span>{workspaceTabLabel(tab)}</span>
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

function WorkspaceBottomBar() {
  const ctx = useWorkspaceContext()
  return <WorkspaceTabBar activeWorkspaceId={ctx.workspace.id} activeWorkspaceName={ctx.workspace.name} />
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
