import { useEffect, useState } from 'react'
import { envTrpc } from '../../../env-trpc'
import { extractTrpcMessage } from '../../../lib/utils'
import { useEnv } from '../env-context'
import { Popover } from './popover'
import type { PaneContent } from './tab-state'

interface ShellRow {
  id: string
  alive: boolean
  cols: number
  rows: number
  cwd: string
  ownerKind?: string
}

interface PortRow {
  port: number
  process?: string | null
  address: string
}

interface ShellsDropdownProps {
  onOpen: (content: PaneContent) => void
}

export function ShellsDropdown({ onOpen }: ShellsDropdownProps) {
  const shells = envTrpc.shell.list.useQuery(undefined, { refetchInterval: 5_000 })
  const utils = envTrpc.useUtils()
  const dispose = envTrpc.shell.dispose.useMutation()
  const [error, setError] = useState<string | null>(null)
  const list = (shells.data ?? []) as ShellRow[]

  async function onTerminate(id: string) {
    setError(null)
    try {
      await dispose.mutateAsync({ id })
      await utils.shell.list.invalidate()
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
                    <div className="flex items-center gap-1.5 truncate font-mono text-neutral-200">
                      <span>shell {s.id.slice(-8)}</span>
                      {s.ownerKind === 'agent' && (
                        <span className="rounded border border-brand-500/40 bg-brand-500/10 px-1 py-[1px] text-[8px] uppercase tracking-wide text-brand-500">
                          agent
                        </span>
                      )}
                    </div>
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
  onOpen: (content: PaneContent) => void
}

export function PreviewsDropdown({ onOpen }: PreviewsDropdownProps) {
  const [ports, setPorts] = useState<PortRow[]>([])
  const snapshot = envTrpc.preview.portsSnapshot.useQuery()

  useEffect(() => {
    if (snapshot.data) setPorts(snapshot.data as PortRow[])
  }, [snapshot.data])

  envTrpc.preview.ports.useSubscription(undefined, {
    onData: (evt: unknown) => {
      const e = evt as { ports?: PortRow[] }
      if (Array.isArray(e?.ports)) setPorts(e.ports)
    },
    onError: () => {},
  })

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
