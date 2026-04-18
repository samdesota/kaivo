import { useEffect, useState } from 'react'
import { trpc } from '../../trpc'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '../../../server/trpc/router'

type RouterOutput = inferRouterOutputs<AppRouter>
type Port = RouterOutput['preview']['portsSnapshot'][number]

export function PortsPanel({
  sandboxId,
  onPreview,
}: {
  sandboxId: string
  onPreview: (port: number) => void
}) {
  const [ports, setPorts] = useState<Port[]>([])
  const snapshot = trpc.preview.portsSnapshot.useQuery({ sandboxId })

  useEffect(() => {
    if (snapshot.data) setPorts(snapshot.data)
  }, [snapshot.data])

  trpc.preview.ports.useSubscription(
    { sandboxId },
    {
      onData: (evt) => {
        if (evt.sandboxId === sandboxId) setPorts(evt.ports)
      },
      onError: () => {
        // let the snapshot query pick us back up
      },
    },
  )

  return (
    <div className="space-y-2 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Ports</h3>
      {ports.length === 0 ? (
        <p className="text-xs text-neutral-600">No listening ports.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {ports.map((p) => (
            <li
              key={`${p.port}-${p.process ?? ''}`}
              className="flex items-center justify-between rounded border border-neutral-800 bg-neutral-900 px-2 py-1"
            >
              <div className="min-w-0 flex-1 truncate">
                <div className="font-mono text-neutral-200">:{p.port}</div>
                <div className="truncate text-neutral-500">
                  {p.process ?? 'unknown'} · {p.address}
                </div>
              </div>
              <button
                onClick={() => onPreview(p.port)}
                className="ml-2 rounded border border-neutral-700 bg-neutral-950 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-300 hover:bg-neutral-800"
              >
                preview
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
