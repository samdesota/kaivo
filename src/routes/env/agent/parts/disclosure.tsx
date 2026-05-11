import type { ReactNode } from 'react'

export function DisclosureHeader({
  open,
  onToggle,
  children,
}: {
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onToggle}
      className="flex min-w-0 w-full items-center gap-2 rounded py-0.5 text-left hover:bg-neutral-900/40"
    >
      <span className="inline-flex w-3 justify-center font-mono text-ui-muted">
        {open ? '▾' : '▸'}
      </span>
      {children}
    </button>
  )
}

export function DisclosureBody({ children }: { children: ReactNode }) {
  return (
    <div className="ml-[5px] min-w-0 border-l border-neutral-800 pl-3 pt-1">
      {children}
    </div>
  )
}
