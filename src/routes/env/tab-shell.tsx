import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { AgentSessionView } from './agent/session-view'
import { EnvContextProvider, type EnvContextValue } from './env-context'
import { CommandPalette } from './shell/command-palette'
import { ShellsDropdown, PreviewsDropdown } from './shell/dropdowns'
import { RightPane } from './shell/right-pane'
import { ShellChrome } from './shell/shell-chrome'
import { type PaneContent, useRightPaneState } from './shell/tab-state'
import type { EnvRef } from '../../lib/env-client'

interface OpenPaneOptions {
  title?: string
  activate?: boolean
}

interface EnvRow extends EnvRef {
  label: string
  status: string
}

export function EnvTabShell({ env }: { env: EnvRow }) {
  const [state, dispatch] = useRightPaneState(env.id)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)

  const openContent = (content: PaneContent, options?: OpenPaneOptions) => {
    dispatch({ type: 'open', content, title: options?.title, activate: options?.activate ?? true })
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
      <AgentSessionView
        onOpenPane={openContent}
        onActiveSessionChange={setActiveSessionId}
      />
    </section>
  )

  return (
    <>
      <ShellChrome
        title={env.label}
        subtitle={`${env.kind} · ${env.status}`}
        backTo="/"
        splitStorageKey={`env.${env.id}.splitRatio`}
        left={agentSection}
        right={
          hasTabs ? (
            <section className="flex h-full min-h-0 w-full flex-col" aria-label="Tabs">
              <RightPane state={state} dispatch={dispatch} />
            </section>
          ) : undefined
        }
        actions={
          <>
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
          </>
        }
      />

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenContent={openContent}
        onCloseTab={() => {
          if (state.activeTabId) dispatch({ type: 'close', tabId: state.activeTabId })
        }}
        hasActiveTab={hasTabs}
        activeSessionId={activeSessionId}
      />
    </>
  )
}

// Re-export the context wrapper so env.tsx can supply env/envToken to the tree.
export { EnvContextProvider, type EnvContextValue }
