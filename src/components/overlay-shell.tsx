import type { ReactNode } from 'react'

export function OverlayShell({
  children,
  footer,
  onClose,
  panelClassName = '',
  footerClassName = '',
}: {
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  panelClassName?: string
  footerClassName?: string
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`w-full max-w-xl overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl ${panelClassName}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
        {footer && <div className={`flex items-center gap-3 border-t border-neutral-800 px-4 py-1.5 text-[10px] text-neutral-500 ${footerClassName}`}>{footer}</div>}
      </div>
    </div>
  )
}
