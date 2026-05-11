import type { PermissionRequest } from '../transcript-store'

/**
 * A single permission request row — display only, no actions.
 * Actions (Allow all / Don't ask again / Reject all) live in the parent tray.
 */
export function PermissionRow({ req }: { req: PermissionRequest }) {
  const pattern = Array.isArray(req.pattern) ? req.pattern.join(', ') : req.pattern
  const title = req.title ?? 'Permission requested'

  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <span className="min-w-0 truncate text-[13px] font-medium text-neutral-200">{title}</span>
      {pattern && pattern !== title && (
        <span className="min-w-0 truncate font-mono text-[12px] text-neutral-500">{pattern}</span>
      )}
    </div>
  )
}
