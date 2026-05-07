import { useEffect, useRef, useState, type ReactNode } from 'react'

interface PopoverProps {
  label: ReactNode
  count?: number
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  side?: 'top' | 'bottom'
}

export function Popover({ label, count, children, align = 'left', side = 'bottom' }: PopoverProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          'flex items-center gap-1.5 rounded px-2 py-1 text-xs ' +
          (open
            ? 'bg-neutral-800 text-neutral-100'
            : 'text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100')
        }
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span>{label}</span>
        {count !== undefined && (
          <span className="rounded bg-neutral-800 px-1 text-[10px] text-neutral-300">{count}</span>
        )}
        <span aria-hidden className="text-neutral-500">
          {side === 'top' ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div
          className={
            'absolute z-30 w-80 rounded border border-neutral-800 bg-neutral-950 shadow-lg ' +
            (side === 'top' ? 'bottom-full mb-1 ' : 'top-full mt-1 ') +
            (align === 'right' ? 'right-0' : 'left-0')
          }
          role="menu"
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
