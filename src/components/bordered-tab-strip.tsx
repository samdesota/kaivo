import type { MouseEvent, ReactNode } from 'react'
import { cn } from '../lib/utils'

export interface BorderedTabItem {
  id: string
  label: ReactNode
  title?: string
  closeTitle?: string
}

export function BorderedTabStrip({
  items,
  activeId,
  onSelect,
  onClose,
  onContextMenu,
  focused = false,
  className,
}: {
  items: BorderedTabItem[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose?: (id: string) => void
  onContextMenu?: (id: string, event: MouseEvent) => void
  focused?: boolean
  className?: string
}) {
  return (
    <div
      role="tablist"
      className={cn(
        'no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden whitespace-nowrap',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.id === activeId
        return (
          <div
            key={item.id}
            role="tab"
            aria-selected={active}
            onContextMenu={onContextMenu ? (event) => onContextMenu(item.id, event) : undefined}
            className={cn(
              'group relative flex min-w-[100px] max-w-[250px] shrink-0 items-stretch border-l border-neutral-800 transition-colors first:border-l-0 last:border-r',
              active ? 'bg-highlight text-neutral-200' : 'text-neutral-400 hover:bg-highlight hover:text-neutral-200',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-neutral-400 transition-opacity',
                focused && active ? 'opacity-100' : 'opacity-0',
              )}
            />
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              className="min-w-0 flex-1 py-1 pl-2 pr-1 text-left text-xs"
              title={item.title}
            >
              <span className="block truncate align-middle">{item.label}</span>
            </button>
            {onClose && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(item.id)
                }}
                className="ml-auto flex w-7 items-center justify-center text-sm leading-none text-neutral-500 opacity-70 hover:text-neutral-100 hover:opacity-100"
                aria-label="Close tab"
                title={item.closeTitle ?? 'Close tab'}
              >
                ×
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
