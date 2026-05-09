import type { PermissionRequest } from '../transcript-store'

export function PermissionBanner({
  req,
  compact = false,
  busy = false,
  onApprove,
  onReject,
}: {
  req: PermissionRequest
  compact?: boolean
  busy?: boolean
  onApprove: (always: boolean) => void | Promise<void>
  onReject: () => void | Promise<void>
}) {
  const pattern = Array.isArray(req.pattern) ? req.pattern.join(', ') : req.pattern

  return (
    <div className={(compact ? 'p-1.5' : 'p-2 shadow-lg shadow-black/20') + ' rounded border border-amber-500/40 bg-amber-500/5'}>
      <div className={compact ? 'flex items-center justify-between gap-2' : 'flex items-center justify-between gap-3'}>
        <div className="min-w-0">
          <div className={(compact ? 'text-[11px]' : 'text-xs') + ' font-medium text-amber-200'}>{req.title ?? 'Approval required'}</div>
          {pattern && <div className={(compact ? 'text-[10px]' : 'text-[11px]') + ' truncate font-mono text-amber-300/70'}>{pattern}</div>}
        </div>
        <div className={(compact ? 'gap-1' : 'gap-2') + ' flex shrink-0 items-center'}>
          <button
            onClick={() => void onApprove(false)}
            disabled={busy}
            className={(compact ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-[11px]') + ' rounded bg-amber-500 font-medium text-black hover:bg-amber-400 disabled:opacity-60'}
          >
            Approve
          </button>
          <button
            onClick={() => void onApprove(true)}
            disabled={busy}
            className={(compact ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-[11px]') + ' rounded border border-amber-500/50 bg-amber-500/10 font-medium text-amber-100 hover:bg-amber-500/20 disabled:opacity-60'}
          >
            Always allow
          </button>
          <button
            onClick={() => void onReject()}
            disabled={busy}
            className={(compact ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-[11px]') + ' rounded border border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800 disabled:opacity-60'}
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  )
}
