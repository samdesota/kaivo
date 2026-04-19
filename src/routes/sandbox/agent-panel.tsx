import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { trpc } from '../../trpc'
import { extractTrpcMessage } from '../../lib/utils'

export function AgentPanel({ sandboxId }: { sandboxId: string }) {
  const [key, setKey] = useState(0)
  const status = trpc.agent.agentStatus.useQuery(
    { sandboxId },
    { refetchInterval: 5_000 },
  )
  const start = trpc.agent.startAgent.useMutation()
  const [startError, setStartError] = useState<string | null>(null)

  async function onStart() {
    setStartError(null)
    try {
      await start.mutateAsync({ sandboxId })
      setKey((k) => k + 1)
      await status.refetch()
    } catch (err) {
      setStartError(extractTrpcMessage(err))
    }
  }

  const src = `/sandbox/${sandboxId}/agent/`

  if (status.isLoading) {
    return <div className="flex h-full items-center justify-center text-sm text-neutral-500">Checking agent…</div>
  }

  if (!status.data?.hasProvider) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-sm text-neutral-300">No AI provider configured.</div>
        <p className="max-w-sm text-xs text-neutral-500">
          The built-in agent (OpenCode) needs an Anthropic or OpenAI API key.
          Add one in Settings.
        </p>
        <Link
          to="/settings"
          className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm hover:bg-neutral-800"
        >
          Open Settings →
        </Link>
      </div>
    )
  }

  if (!status.data.ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-sm text-neutral-300">Agent not running.</div>
        <button
          onClick={() => void onStart()}
          disabled={start.isPending}
          className="rounded-md bg-brand-500 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-600 disabled:opacity-60"
        >
          {start.isPending ? 'Starting…' : 'Start agent'}
        </button>
        {startError && (
          <p className="max-w-sm text-xs text-red-400">{startError}</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-3 py-1.5 text-xs">
        <span className="font-mono text-neutral-300">agent</span>
        <button
          onClick={() => setKey((k) => k + 1)}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 hover:bg-neutral-800"
        >
          reload
        </button>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 hover:bg-neutral-800"
        >
          open
        </a>
      </div>
      <iframe
        key={key}
        src={src}
        title="agent"
        className="flex-1 bg-white"
        sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
      />
    </div>
  )
}
