import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { SplitPane } from './split-pane'

export function ShellChrome({
  title,
  subtitle,
  backTo,
  actions,
  left,
  right,
  splitStorageKey,
  splitInitialRatio = 0.7,
  onSplitRatioChange,
  className = 'h-screen',
}: {
  title: string
  subtitle?: string
  backTo?: string
  actions: ReactNode
  left: ReactNode
  right?: ReactNode
  splitStorageKey: string
  splitInitialRatio?: number
  onSplitRatioChange?: (ratio: number) => void
  className?: string
}) {
  return (
    <div className={`flex flex-col bg-neutral-950 text-neutral-100 ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          {backTo && (
            <Link to={backTo} className="text-brand-500 hover:underline" title="Back to dashboard">
              ←
            </Link>
          )}
          <h1 className="truncate text-sm font-semibold">{title}</h1>
          {subtitle && <span className="truncate text-xs text-neutral-500">{subtitle}</span>}
        </div>
        <div className="flex items-center gap-2">{actions}</div>
      </header>

      {right ? (
        <SplitPane
          storageKey={splitStorageKey}
          initialRatio={splitInitialRatio}
          onRatioChange={onSplitRatioChange}
          left={left}
          right={right}
        />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1">{left}</div>
      )}
    </div>
  )
}
