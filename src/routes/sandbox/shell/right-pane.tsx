import { useEffect, useMemo } from 'react'
import { trpc } from '../../../trpc'
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
  sandboxId: string
  state: RightPaneState
  dispatch: React.Dispatch<RightPaneAction>
}

export function RightPane({ sandboxId, state, dispatch }: RightPaneProps) {
  const shells = trpc.shell.list.useQuery({ sandboxId }, { refetchInterval: 5_000 })

  const liveShellIds = useMemo(() => {
    if (!shells.data) return null
    return new Set(shells.data.map((s) => s.id))
  }, [shells.data])

  useEffect(() => {
    if (!liveShellIds) return
    dispatch({ type: 'pruneShells', liveShellIds })
  }, [liveShellIds, dispatch])

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId) ?? state.tabs[0]

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950">
      <div
        role="tablist"
        className="flex items-center gap-0.5 overflow-x-auto border-b border-neutral-800 bg-neutral-950 px-2 py-1"
      >
        {state.tabs.map((t) => {
          const active = t.id === state.activeTabId
          return (
            <div
              key={t.id}
              role="tab"
              aria-selected={active}
              className={
                'group flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs ' +
                (active
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200')
              }
            >
              <button
                onClick={() => dispatch({ type: 'activate', tabId: t.id })}
                className="max-w-[200px] truncate"
                title={tabTitleDetail(t.content)}
              >
                {t.title || defaultTitle(t.content)}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  dispatch({ type: 'close', tabId: t.id })
                }}
                className="rounded px-1 text-neutral-500 hover:bg-neutral-700 hover:text-neutral-100"
                aria-label="Close tab"
                title="Close tab"
              >
                ×
              </button>
            </div>
          )
        })}
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {state.tabs.map((t) => {
          const active = t.id === activeTab?.id
          // Mount every tab so each keeps its own state; hide the inactive ones.
          return (
            <div
              key={t.id}
              role="tabpanel"
              aria-hidden={!active}
              className={'h-full min-h-0 ' + (active ? 'block' : 'hidden')}
            >
              <TabContent
                sandboxId={sandboxId}
                tabId={t.id}
                content={t.content}
                active={active}
                dispatch={dispatch}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TabContent({
  sandboxId,
  tabId,
  content,
  active,
  dispatch,
}: {
  sandboxId: string
  tabId: string
  content: PaneContent
  active: boolean
  dispatch: React.Dispatch<RightPaneAction>
}) {
  if (content.type === 'shell') return <ShellTabContent sandboxId={sandboxId} shellId={content.shellId} />
  if (content.type === 'file') return <FileTabContent sandboxId={sandboxId} path={content.path} />
  if (content.type === 'preview') return <PreviewTabContent sandboxId={sandboxId} port={content.port} />
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
      />
    )
  }
  return null
}

function tabTitleDetail(c: PaneContent): string {
  if (c.type === 'shell') return c.shellId
  if (c.type === 'file') return c.path
  if (c.type === 'preview') return `port ${c.port}`
  if (c.type === 'browser') return c.url ?? c.browserTabId ?? 'browser'
  return ''
}
