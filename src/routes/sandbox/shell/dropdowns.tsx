import { useEffect, useState } from 'react'
import { trpc } from '../../../trpc'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '../../../../server/trpc/router'
import { extractTrpcMessage } from '../../../lib/utils'
import { Popover } from './popover'
import type { PaneContent } from './tab-state'

type RouterOutput = inferRouterOutputs<AppRouter>
type ShellRow = RouterOutput['shell']['list'][number]
type PortRow = RouterOutput['preview']['portsSnapshot'][number]

interface ShellsDropdownProps {
  sandboxId: string
  onOpen: (content: PaneContent) => void
}

export function ShellsDropdown({ sandboxId, onOpen }: ShellsDropdownProps) {
  const shells = trpc.shell.list.useQuery({ sandboxId }, { refetchInterval: 5_000 })
  const utils = trpc.useUtils()
  const dispose = trpc.shell.dispose.useMutation()
  const [error, setError] = useState<string | null>(null)
  const list = shells.data ?? []

  async function onTerminate(id: string) {
    setError(null)
    try {
      await dispose.mutateAsync({ id })
      await utils.shell.list.invalidate({ sandboxId })
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  return (
    <Popover label="Shells" count={list.length}>
      {(close) => (
        <div className="p-1">
          {list.length === 0 ? (
            <div className="px-3 py-4 text-xs text-neutral-500">No shells running.</div>
          ) : (
            <ul className="space-y-1">
              {list.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-neutral-900"
                >
                  <span
                    className={
                      'h-1.5 w-1.5 shrink-0 rounded-full ' +
                      (s.alive ? 'bg-emerald-500' : 'bg-neutral-600')
                    }
                    title={s.alive ? 'running' : 'stopped'}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-neutral-200">shell {s.id.slice(-8)}</div>
                    <div className="truncate text-[10px] text-neutral-500">
                      {s.cols}×{s.rows} · cwd {s.cwd}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      onOpen({ type: 'shell', shellId: s.id })
                      close()
                    }}
                    className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-200 hover:bg-neutral-800"
                  >
                    open
                  </button>
                  <button
                    onClick={() => void onTerminate(s.id)}
                    className="rounded border border-neutral-800 bg-neutral-950 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400 hover:border-red-900 hover:text-red-400"
                    disabled={dispose.isPending}
                  >
                    terminate
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <div className="px-3 py-2 text-[10px] text-red-400">{error}</div>
          )}
        </div>
      )}
    </Popover>
  )
}

interface PreviewsDropdownProps {
  sandboxId: string
  onOpen: (content: PaneContent) => void
}

export function PreviewsDropdown({ sandboxId, onOpen }: PreviewsDropdownProps) {
  const [ports, setPorts] = useState<PortRow[]>([])
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
      onError: () => {},
    },
  )

  return (
    <Popover label="Previews" count={ports.length}>
      {(close) => (
        <div className="p-1">
          {ports.length === 0 ? (
            <div className="px-3 py-4 text-xs text-neutral-500">No listening ports.</div>
          ) : (
            <ul className="space-y-1">
              {ports.map((p) => (
                <li
                  key={`${p.port}-${p.process ?? ''}`}
                  className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-neutral-900"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-neutral-200">:{p.port}</div>
                    <div className="truncate text-[10px] text-neutral-500">
                      {p.process ?? 'unknown'} · {p.address}
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      onOpen({ type: 'preview', port: p.port })
                      close()
                    }}
                    className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-200 hover:bg-neutral-800"
                  >
                    open
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Popover>
  )
}

export type { ShellRow, PortRow }
