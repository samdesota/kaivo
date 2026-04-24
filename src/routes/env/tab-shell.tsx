import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { AgentSessionView } from './agent/session-view'
import { EnvContextProvider, type EnvContextValue } from './env-context'
import { CommandPalette } from './shell/command-palette'
import { ShellsDropdown, PreviewsDropdown } from './shell/dropdowns'
import { RightPane } from './shell/right-pane'
import { SplitPane } from './shell/split-pane'
import { type PaneContent, useRightPaneState } from './shell/tab-state'
import type { EnvRef } from '../../lib/env-client'

interface EnvRow extends EnvRef {
  label: string
  status: string
}

export function EnvTabShell({ env }: { env: EnvRow }) {
  const [state, dispatch] = useRightPaneState(env.id)
  const [paletteOpen, setPaletteOpen] = useState(false)

  const openContent = (content: PaneContent) => {
    dispatch({ type: 'open', content, activate: true })
  }

  useEffect(() => {
    const prev = document.title
    document.title = `${env.label} - cc`
    return () => {
      document.title = prev
    }
  }, [env.label])

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
      <AgentSessionView onOpenShell={openContent} />
    </section>
  )

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link to="/" className="text-brand-500 hover:underline" title="Back to dashboard">
            ←
          </Link>
          <h1 className="truncate text-sm font-semibold">{env.label}</h1>
          <span className="truncate text-xs text-neutral-500">
            {env.kind} · {env.status}
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
          <ShellsDropdown onOpen={openContent} />
          <PreviewsDropdown onOpen={openContent} />
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
          storageKey={`env.${env.id}.splitRatio`}
          initialRatio={0.7}
          left={agentSection}
          right={
            <section className="flex h-full min-h-0 w-full flex-col" aria-label="Tabs">
              <RightPane state={state} dispatch={dispatch} />
            </section>
          }
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">{agentSection}</div>
      )}

      <CommandPalette
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

// Re-export the context wrapper so env.tsx can supply env/envToken to the tree.
export { EnvContextProvider, type EnvContextValue }
