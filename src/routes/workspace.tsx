import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { trpc } from '../trpc'
import { envTrpc, makeEnvReactClient } from '../env-trpc'
import { extractTrpcMessage } from '../lib/utils'
import { useLocalEnvIdentity } from '../lib/local-env-discovery'
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
  const localIdentity = useLocalEnvIdentity()
  const workspace = trpc.workspace.get.useQuery({ id: workspaceId })
  const uiState = trpc.workspace.getUiState.useQuery({ workspaceId })
  const envs = trpc.env.list.useQuery(
    localIdentity.label ? { localIdentityLabel: localIdentity.label } : {},
    { refetchInterval: 10_000 },
  )
  const markOpened = trpc.workspace.markOpened.useMutation({
    onSuccess: () => utils.workspace.list.invalidate(),
  })
  const saveUiState = trpc.workspace.saveUiState.useMutation()
  const [workspaceState, dispatchWorkspaceState] = useReducer(
    workspaceUiReducer,
    emptyWorkspaceUiState(),
  )
  const [hydrated, setHydrated] = useState(false)
  const hydratedWorkspaceId = useRef<string | null>(null)

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
    setHydrated(true)
  }, [uiState.data, search.chat, search.tab])

  useEffect(() => {
    if (!workspace.data || !hydrated) return
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
  }, [workspaceState, workspace.data?.id, hydrated])

  const envTargets = useMemo(() => {
    return ((envs.data ?? []) as WorkspaceEnvRow[]).map(resolveWorkspaceEnvTarget)
  }, [envs.data])
  const localEnvTarget = useMemo(() => selectLocalEnvTarget(envTargets), [envTargets])
  const getEnvClient = useMemo(
    () => createWorkspaceEnvClientResolver(envTargets),
    [envTargets],
  )

  if (workspace.isLoading || uiState.isLoading || envs.isLoading || localIdentity.loading) {
    return <div className="p-8 text-neutral-500">Loading workspace…</div>
  }
  if (workspace.error) return <WorkspaceError message={extractTrpcMessage(workspace.error)} />
  if (uiState.error) return <WorkspaceError message={extractTrpcMessage(uiState.error)} />
  if (envs.error) return <WorkspaceError message={extractTrpcMessage(envs.error)} />
  if (!workspace.data || !uiState.data) {
    return <WorkspaceError message="Workspace did not load." />
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
  const onSplitRatioChange = useCallback(
    (ratio: number) => dispatchWorkspaceState({ type: 'setSplitRatio', splitRatio: ratio }),
    [dispatchWorkspaceState],
  )
  const openPane = useWorkspaceOpenPane(dispatchWorkspaceState)
  const closeActiveTab = useCallback(() => {
    if (ctx.uiState.activeWorkspaceTabId) {
      dispatchWorkspaceState({ type: 'closeTab', tabId: ctx.uiState.activeWorkspaceTabId })
    }
  }, [ctx.uiState.activeWorkspaceTabId, dispatchWorkspaceState])
  return (
    <div className="flex h-screen flex-col">
      <ShellChrome
        className="min-h-0 flex-1"
        title={ctx.workspace.name}
        subtitle={ctx.localEnvTarget ? `local · ${ctx.localEnvTarget.env.label}` : 'local env unavailable'}
        splitStorageKey={`workspace.${ctx.workspace.id}.splitRatio`}
        splitInitialRatio={ctx.uiState.splitRatio ?? 0.7}
        onSplitRatioChange={onSplitRatioChange}
        actions={
          <WorkspaceHeaderActions
            onCommandPalette={() => setPaletteOpen(true)}
            onOpenPane={openPane}
          />
        }
        left={<WorkspaceAgentPane dispatchWorkspaceState={dispatchWorkspaceState} />}
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
      <Link to="/dashboard" className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200">
        Environments
      </Link>
      <Link to="/settings" className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200">
        Settings
      </Link>
    </>
  )
}

function WorkspaceAgentPane({
  dispatchWorkspaceState,
}: {
  dispatchWorkspaceState: WorkspaceUiDispatch
}) {
  const ctx = useWorkspaceContext()
  if (!ctx.localEnvTarget?.available) {
    return <AgentPlaceholder message={ctx.localEnvTarget?.unavailableReason ?? 'Local env unavailable'} />
  }
  if (!ctx.localEnvTarget.token) {
    return <AgentPlaceholder message="Local env token unavailable" />
  }
  const openPane = useWorkspaceOpenPane(dispatchWorkspaceState)
  return (
    <section className="flex h-full min-h-0 w-full flex-col" aria-label="Agent Chats">
      <WorkspaceAgentEnvProvider>
        <AgentSessionView
          workspaceId={ctx.workspace.id}
          activeSessionId={ctx.uiState.activeAgentSessionId}
          onSessionSelect={(sessionId) => dispatchWorkspaceState({ type: 'setActiveAgentSession', sessionId })}
          onActiveSessionChange={(sessionId) => dispatchWorkspaceState({ type: 'setActiveAgentSession', sessionId })}
          onOpenPane={openPane}
        />
      </WorkspaceAgentEnvProvider>
    </section>
  )
}

function useWorkspaceOpenPane(dispatchWorkspaceState: WorkspaceUiDispatch) {
  const ctx = useWorkspaceContext()
  return useCallback(
    (content: PaneContent, options?: { title?: string; activate?: boolean }) => {
      const envId = ctx.localEnvTarget?.env.id
      if (!envId && content.type !== 'browser') return
      const id = `${content.type}-${envId ?? 'browser'}-${Date.now()}`
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

function AgentPlaceholder({ message = 'Start a new agent chat' }: { message?: string }) {
  return (
    <section className="flex h-full min-h-0 w-full flex-col" aria-label="Agent Chats">
      <div className="flex items-center gap-1 border-b border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-500">
        <button className="rounded border border-neutral-800 px-2 py-1 text-neutral-400">+ chat</button>
      </div>
      <div className="flex flex-1 items-center justify-center text-neutral-500">{message}</div>
    </section>
  )
}

function WorkspaceTabPane({
  dispatchWorkspaceState,
}: {
  dispatchWorkspaceState: WorkspaceUiDispatch
}) {
  const ctx = useWorkspaceContext()
  const activeTab =
    ctx.uiState.workspaceTabs.find((tab) => tab.id === ctx.uiState.activeWorkspaceTabId) ??
    ctx.uiState.workspaceTabs[0]
  const unavailableReason = activeTab
    ? unavailableReasonForWorkspaceTab(activeTab, ctx.envTargets)
    : null
  return (
    <section className="flex h-full min-h-0 w-full flex-col bg-neutral-950" aria-label="Workspace Tabs">
      <div role="tablist" className="flex items-center gap-0.5 overflow-x-auto border-b border-neutral-800 px-2 py-1">
        {ctx.uiState.workspaceTabs.map((tab) => (
          <div
            key={tab.id}
            role="tab"
            aria-selected={tab.id === ctx.uiState.activeWorkspaceTabId}
            className={
              'group flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs ' +
              (tab.id === ctx.uiState.activeWorkspaceTabId
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200')
            }
          >
            <button onClick={() => dispatchWorkspaceState({ type: 'activateTab', tabId: tab.id })}>
              {tab.title}
            </button>
            <button
              onClick={() => dispatchWorkspaceState({ type: 'closeTab', tabId: tab.id })}
              className="rounded px-1 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100"
              aria-label="Close tab"
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
            onClose={() => dispatchWorkspaceState({ type: 'closeTab', tabId: activeTab.id })}
            onBrowserTabId={(browserTabId) =>
              dispatchWorkspaceState({ type: 'setBrowserTabId', tabId: activeTab.id, browserTabId })
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
}: {
  tab: WorkspaceTab
  onClose: () => void
  onBrowserTabId: (browserTabId: string) => void
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
        />
      </div>
    )
  }
  return <span>{workspaceTabLabel(tab)}</span>
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
          Back to dashboard
        </Link>
      </div>
    </div>
  )
}
