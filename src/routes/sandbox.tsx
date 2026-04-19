import { useParams, useNavigate } from '@tanstack/react-router'
import { trpc } from '../trpc'
import { extractTrpcMessage } from '../lib/utils'
import { TabShell } from './sandbox/shell/tab-shell'

export function SandboxDetailPage() {
  const { id } = useParams({ from: '/sandbox/$id' })
  const navigate = useNavigate()
  const sb = trpc.sandbox.get.useQuery({ id }, { refetchInterval: 5_000 })

  if (sb.isLoading) {
    return <div className="p-8 text-neutral-500">Loading sandbox…</div>
  }
  if (sb.error) {
    return (
      <div className="p-8 text-red-400">
        {extractTrpcMessage(sb.error)}
        <div className="mt-4">
          <button
            className="text-brand-500 hover:underline"
            onClick={() => void navigate({ to: '/' })}
          >
            Back
          </button>
        </div>
      </div>
    )
  }
  if (!sb.data) return null

  return (
    <TabShell
      sandboxId={sb.data.id}
      sandboxName={sb.data.name}
      sandboxStatus={sb.data.status}
      running={sb.data.running}
    />
  )
}
