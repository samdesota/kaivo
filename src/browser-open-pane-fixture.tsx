import React, { useEffect, useReducer } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { BrowserPane } from './components/browser-pane'
import { handleAgentUiOpenPaneEvent } from './lib/agent-ui-open-pane'
import { initialState, rightPaneReducer, type PaneContent } from './routes/env/shell/tab-state'

declare global {
  interface Window {
    cloudCodeOpenBrowserPane: (url: string) => void
  }
}

function Fixture() {
  const [state, dispatch] = useReducer(rightPaneReducer, undefined, initialState)
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)

  useEffect(() => {
    window.cloudCodeOpenBrowserPane = (url: string) => {
      handleAgentUiOpenPaneEvent<PaneContent>(
        {
          type: 'open_pane',
          content: { type: 'browser', url },
          title: 'Browser Fixture',
          activate: true,
        },
        (content, options) => {
          dispatch({ type: 'open', content, title: options?.title, activate: options?.activate })
        },
      )
    }
  }, [])

  return (
    <main className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <h1 className="p-3 text-sm">Browser Open Pane Fixture</h1>
      <section className="min-h-0 flex-1 border border-neutral-800" aria-label="Fixture pane">
        {activeTab?.content.type === 'browser' ? (
          <BrowserPane
            paneId={activeTab.id}
            url={activeTab.content.url}
            browserTabId={activeTab.content.browserTabId}
            active={true}
            onBrowserTabId={(browserTabId) =>
              dispatch({ type: 'setBrowserTabId', tabId: activeTab.id, browserTabId })
            }
          />
        ) : (
          <div className="p-3 text-sm text-neutral-400">Waiting for open_pane.</div>
        )}
      </section>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<Fixture />)
