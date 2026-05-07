import type { ReactNode } from 'react'

export function SettingsPanel({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section id={id} className="border-t border-neutral-800/80 first:border-t-0">
      <div className="py-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">{title}</h2>
          {action}
        </div>
        {description && <p className="mt-1 max-w-2xl text-xs leading-5 text-neutral-500">{description}</p>}
      </div>
      <div className="pb-5">{children}</div>
    </section>
  )
}
