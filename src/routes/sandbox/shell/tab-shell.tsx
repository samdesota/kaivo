import { Link } from '@tanstack/react-router'
import { AgentPanel } from '../agent-panel'
import { ShellsDropdown, PreviewsDropdown } from './dropdowns'
import { RightPane } from './right-pane'
import { type PaneContent, useRightPaneState } from './tab-state'

interface TabShellProps {
  sandboxId: string
  sandboxName: string
  sandboxStatus: string
  running: boolean
}

export function TabShell({ sandboxId, sandboxName, sandboxStatus, running }: TabShellProps) {
  const [state, dispatch] = useRightPaneState(sandboxId)

  const openContent = (content: PaneContent) => {
    dispatch({ type: 'open', content, activate: true })
  }

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

      <div className="flex min-h-0 flex-1">
        <section
          className="flex min-h-0 min-w-0 shrink-0 basis-[70%] border-r border-neutral-800"
          aria-label="Agents"
        >
          <div className="flex min-h-0 w-full flex-col">
            <AgentPanel sandboxId={sandboxId} />
          </div>
        </section>
        <section
          className="flex min-h-0 min-w-0 basis-[30%]"
          aria-label="Tabs"
        >
          <RightPane sandboxId={sandboxId} state={state} dispatch={dispatch} />
        </section>
      </div>
    </div>
  )
}
