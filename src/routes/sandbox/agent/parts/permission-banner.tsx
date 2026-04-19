import type { PermissionRequest } from '../transcript-store'

/**
 * Inline card rendered next to the tool call that caused the gate. Buttons
 * are display-only in Phase 5; approval wiring ships in Phase 6.
 */
export function PermissionBanner({ req }: { req: PermissionRequest }) {
  const pattern = Array.isArray(req.pattern) ? req.pattern.join(', ') : req.pattern
  return (
    <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/5 p-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-amber-200">{req.title ?? 'Approval required'}</div>
          {pattern && <div className="truncate font-mono text-[11px] text-amber-300/70">{pattern}</div>}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            disabled
            className="cursor-not-allowed rounded bg-amber-500/30 px-2 py-0.5 text-[11px] font-medium text-amber-100 opacity-60"
            title="Approval wiring lands in Phase 6"
          >
            Approve
          </button>
          <button
            disabled
            className="cursor-not-allowed rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-300 opacity-60"
            title="Approval wiring lands in Phase 6"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}
