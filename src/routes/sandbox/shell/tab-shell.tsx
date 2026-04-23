import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { AgentSessionView } from '../agent/session-view'
import { CommandPalette } from './command-palette'
import { ShellsDropdown, PreviewsDropdown, ReposDropdown } from './dropdowns'
import { RightPane } from './right-pane'
import { SplitPane } from './split-pane'
import { type PaneContent, useRightPaneState } from './tab-state'

interface TabShellProps {
  sandboxId: string
  sandboxName: string
  sandboxStatus: string
  running: boolean
}

export function TabShell({ sandboxId, sandboxName, sandboxStatus, running }: TabShellProps) {
  const [state, dispatch] = useRightPaneState(sandboxId)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const openContent = (content: PaneContent) => {
    dispatch({ type: 'open', content, activate: true })
  }

  // Reflect the active sandbox in the document title so browser tabs are
  // distinguishable. Restore the bare app title when leaving the sandbox.
  useEffect(() => {
    const prev = document.title
    document.title = `${sandboxName} - cc`
    return () => {
      document.title = prev
    }
  }, [sandboxName])

  // Cmd-K (or Ctrl-K) toggles the command palette globally. Bound at the
  // shell level so it works whether focus is in the agent, a tab, or nowhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const hasTabs = state.tabs.length > 0
  const agentSection = (
    <section className="flex h-full min-h-0 w-full flex-col" aria-label="Agents">
      <AgentSessionView sandboxId={sandboxId} onOpenShell={openContent} />
    </section>
  )

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link to="/" className="text-brand-500 hover:underline" title="Back to dashboard">
            ←
          </Link>
          <h1 className="truncate text-sm font-semibold">{sandboxName}</h1>
          <span className="truncate text-xs text-neutral-500">
            {sandboxId} · {sandboxStatus} {running ? '(running)' : '(stopped)'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPaletteOpen(true)}
            className="rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            title="Open command palette (⌘K)"
          >
            ⌘K
          </button>
          <ReposDropdown sandboxId={sandboxId} />
          <ShellsDropdown sandboxId={sandboxId} onOpen={openContent} />
          <PreviewsDropdown sandboxId={sandboxId} onOpen={openContent} />
          <Link
            to="/settings"
            className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
          >
            Settings
          </Link>
        </div>
      </header>

      {hasTabs ? (
        <SplitPane
          storageKey={`sandbox.${sandboxId}.splitRatio`}
          initialRatio={0.7}
          left={agentSection}
          right={
            <section className="flex h-full min-h-0 w-full flex-col" aria-label="Tabs">
              <RightPane sandboxId={sandboxId} state={state} dispatch={dispatch} />
            </section>
          }
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">{agentSection}</div>
      )}

      <CommandPalette
        sandboxId={sandboxId}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenContent={openContent}
        onCloseTab={() => {
          if (state.activeTabId) dispatch({ type: 'close', tabId: state.activeTabId })
        }}
        hasActiveTab={hasTabs}
      />
    </div>
  )
}
