import { useEffect, useMemo, useRef } from 'react'
import { envTrpc } from '../../../env-trpc'
import { BorderedTabStrip, type BorderedTabItem } from '../../../components/bordered-tab-strip'
import { browserApi } from '../../../lib/browser-api'
import { FileTabContent } from '../tabs/file-tab'
import { BrowserTabContent } from '../tabs/browser-tab'
import { PreviewTabContent } from '../tabs/preview-tab'
import { ShellTabContent } from '../tabs/shell-tab'
import {
  type PaneContent,
  type RightPaneAction,
  type RightPaneState,
  defaultTitle,
} from './tab-state'

interface RightPaneProps {
  state: RightPaneState
  dispatch: React.Dispatch<RightPaneAction>
  workspaceId?: string
}

interface ShellRow {
  id: string
  title?: string | null
}

export function RightPane({ state, dispatch, workspaceId }: RightPaneProps) {
  const shells = envTrpc.shell.list.useQuery(workspaceId ? { workspaceId } : undefined, { refetchInterval: 5_000 })
  const tabsRef = useRef(state.tabs)

  tabsRef.current = state.tabs

  const liveShellIds = useMemo(() => {
    if (!shells.data) return null
    return new Set((shells.data as ShellRow[]).map((s) => s.id))
  }, [shells.data])

  useEffect(() => {
    if (!liveShellIds) return
    dispatch({ type: 'pruneShells', liveShellIds })
  }, [liveShellIds, dispatch])

  useEffect(() => {
    if (!shells.data) return
    const shellTitles = new Map((shells.data as ShellRow[]).map((shell) => [shell.id, shell.title?.trim() || `shell ${shell.id.slice(-6)}`]))
    for (const tab of state.tabs) {
      if (tab.content.type !== 'shell') continue
      if (tab.titleSource === 'explicit') continue
      const title = shellTitles.get(tab.content.shellId)
      if (title && title !== tab.title) dispatch({ type: 'setAutoTitle', tabId: tab.id, title })
    }
  }, [dispatch, shells.data, state.tabs])

  useEffect(() => {
    return browserApi.onWindowTabCreated((event) => {
      if (event.presentation === 'popup') return
      if (!event.openerBrowserTabId) return
      const openedFromThisPane = tabsRef.current.some(
        (tab) => tab.content.type === 'browser' && tab.content.browserTabId === event.openerBrowserTabId,
      )
      if (!openedFromThisPane) return
      dispatch({
        type: 'open',
        content: { type: 'browser', url: event.url, browserTabId: event.browserTabId },
        title: truncateTabTitle(event.title || event.url),
        activate: true,
      })
    })
  }, [dispatch])

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0]
  const tabItems: BorderedTabItem[] = state.tabs.map((t) => ({
    id: t.id,
    label: t.title || defaultTitle(t.content),
    title: tabTitleDetail(t.content),
  }))

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-975">
      <div className="flex flex-none basis-8 items-stretch border-b border-neutral-800 bg-neutral-975">
        <BorderedTabStrip
          items={tabItems}
          activeId={state.activeTabId}
          onSelect={(tabId) => dispatch({ type: 'activate', tabId })}
          onClose={(tabId) => dispatch({ type: 'close', tabId })}
        />
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {state.tabs.map((t) => {
          const active = t.id === activeTab?.id
          return (
            <div
              key={t.id}
              role="tabpanel"
              aria-hidden={!active}
              className={'h-full min-h-0 ' + (active ? 'block' : 'hidden')}
            >
              <TabContent tabId={t.id} content={t.content} active={active} dispatch={dispatch} workspaceId={workspaceId} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TabContent({
  tabId,
  content,
  active,
  dispatch,
  workspaceId,
}: {
  tabId: string
  content: PaneContent
  active: boolean
  dispatch: React.Dispatch<RightPaneAction>
  workspaceId?: string
}) {
  if (content.type === 'shell') return <ShellTabContent shellId={content.shellId} workspaceId={workspaceId} />
  if (content.type === 'file') return <FileTabContent path={content.path} absolute={content.absolute} />
  if (content.type === 'preview') return <PreviewTabContent port={content.port} />
  if (content.type === 'browser') {
    return (
      <BrowserTabContent
        paneId={tabId}
        url={content.url}
        browserTabId={content.browserTabId}
        active={active}
        onBrowserTabId={(browserTabId) =>
          dispatch({ type: 'setBrowserTabId', tabId, browserTabId })
        }
        onUrlChange={(url) => dispatch({ type: 'setBrowserUrl', tabId, url })}
        onTitleChange={(title) => dispatch({ type: 'setTitle', tabId, title: truncateTabTitle(title) })}
      />
    )
  }
  return null
}

function truncateTabTitle(title: string): string {
  const trimmed = title.trim()
  if (!trimmed) return 'Browser'
  return trimmed.length > 48 ? `${trimmed.slice(0, 47)}…` : trimmed
}

function tabTitleDetail(c: PaneContent): string {
  if (c.type === 'shell') return c.shellId
  if (c.type === 'file') return c.path
  if (c.type === 'preview') return `port ${c.port}`
  if (c.type === 'browser') return c.url ?? c.browserTabId ?? 'browser'
  return ''
}
