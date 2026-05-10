import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '../lib/utils'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  widthClass?: string
}

export function Modal({ open, onClose, title, children, widthClass = 'max-w-xl' }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={cn(
          'mt-12 w-full rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl',
          widthClass,
        )}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-header-2">{title}</h2>
          <button
            onClick={onClose}
            className="rounded px-2 py-0.5 text-ui-muted hover:bg-highlight hover:text-header-3"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'

export function Button({
  className,
  variant = 'primary',
  size = 'sm',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-600 disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm',
        variant === 'primary' && 'bg-neutral-700 text-header-1 hover:bg-neutral-600',
        variant === 'secondary' && 'border border-neutral-700 bg-neutral-930 text-header-3 hover:bg-highlight',
        variant === 'ghost' && 'text-ui-default hover:bg-highlight hover:text-header-3',
        variant === 'danger' && 'border border-red-900 bg-red-950/50 text-red-300 hover:bg-red-950',
        className,
      )}
      {...rest}
    />
  )
}

export function Input({
  className,
  size = 'sm',
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: ButtonSize }) {
  return (
    <input
      className={cn(
        'w-full rounded border border-neutral-800 bg-input text-content-strong placeholder-placeholder focus:border-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-600',
        size === 'sm' ? 'px-3 py-2 text-xs' : 'px-3 py-2 text-sm',
        className,
      )}
      {...rest}
    />
  )
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-sm font-medium text-header-3">
      {children}
    </label>
  )
}

export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block text-xs text-ui-default', className)}>
      <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-label">{label}</span>
      {children}
    </label>
  )
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T
  options: Array<{ value: T; label: ReactNode }>
  onChange: (value: T) => void
  ariaLabel?: string
  className?: string
}) {
  return (
    <div className={cn('flex w-full overflow-hidden rounded border border-neutral-800 bg-input', className)} role="group" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex-1 px-2.5 py-1 text-xs transition-colors',
              selected
                ? 'bg-highlight text-header-3'
                : 'text-ui-muted hover:bg-highlight hover:text-content-default',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'w-full max-w-md rounded-xl border border-neutral-800 bg-neutral-950/80 p-8 shadow-xl backdrop-blur',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function FormError({ children }: { children: ReactNode }) {
  if (!children) return null
  return (
    <p className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
      {children}
    </p>
  )
}

export function CenteredLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-neutral-950 via-neutral-900 to-black px-4">
      <div className="window-drag fixed top-0 right-0 left-0 h-10" />
      {children}
    </div>
  )
}
