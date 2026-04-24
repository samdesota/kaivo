import { useState } from 'react'
import { envTrpc } from '../../../../env-trpc'
import { extractTrpcMessage } from '../../../../lib/utils'
import type { PermissionRequest } from '../transcript-store'

export function PermissionBanner({
  req,
  sessionId,
}: {
  req: PermissionRequest
  sessionId: string
}) {
  const [always, setAlways] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const approve = envTrpc.agent.sessionApprove.useMutation()
  const reject = envTrpc.agent.sessionReject.useMutation()
  const pattern = Array.isArray(req.pattern) ? req.pattern.join(', ') : req.pattern
  const busy = approve.isPending || reject.isPending

  async function onApprove() {
    setErr(null)
    try {
      await approve.mutateAsync({ sessionId, permissionId: req.id, always })
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }
  async function onReject() {
    setErr(null)
    try {
      await reject.mutateAsync({ sessionId, permissionId: req.id })
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  return (
    <div className="mt-2 rounded border border-amber-500/40 bg-amber-500/5 p-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-amber-200">{req.title ?? 'Approval required'}</div>
          {pattern && <div className="truncate font-mono text-[11px] text-amber-300/70">{pattern}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-1 text-[11px] text-amber-200/80">
            <input
              type="checkbox"
              checked={always}
              onChange={(e) => setAlways(e.target.checked)}
              disabled={busy}
              className="h-3 w-3 accent-amber-500"
            />
            <span>Always</span>
          </label>
          <button
            onClick={() => void onApprove()}
            disabled={busy}
            className="rounded bg-amber-500 px-2 py-0.5 text-[11px] font-medium text-black hover:bg-amber-400 disabled:opacity-60"
          >
            {approve.isPending ? 'Approving…' : 'Approve'}
          </button>
          <button
            onClick={() => void onReject()}
            disabled={busy}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-neutral-800 disabled:opacity-60"
          >
            {reject.isPending ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      </div>
      {err && (
        <div className="mt-2 rounded border border-red-900 bg-red-950/50 px-2 py-1 text-[11px] text-red-300">
          {err}
        </div>
      )}
    </div>
  )
}
