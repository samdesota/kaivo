import { useState } from 'react'
import { envTrpc } from '../../../env-trpc'
import { extractTrpcMessage } from '../../../lib/utils'
import { XTermAttached } from '../xterm-attached'

interface ShellRow {
  id: string
  alive: boolean
  cols: number
  rows: number
  cwd: string
  ownerKind?: string
}

export function ShellTabContent({
  shellId,
  onTerminated,
}: {
  shellId: string
  onTerminated?: () => void
}) {
  const shells = envTrpc.shell.list.useQuery(undefined, { refetchInterval: 5_000 })
  const utils = envTrpc.useUtils()
  const dispose = envTrpc.shell.dispose.useMutation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const list = (shells.data ?? []) as ShellRow[]
  const info = list.find((s) => s.id === shellId)
  const missing = shells.data && !info

  async function onTerminate() {
    setErr(null)
    try {
      await dispose.mutateAsync({ id: shellId })
      await utils.shell.list.invalidate()
      setMenuOpen(false)
      onTerminated?.()
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-3 py-1.5 text-xs">
        <span className="font-mono text-neutral-300">shell {shellId.slice(-8)}</span>
        {info?.ownerKind === 'agent' && (
          <span className="rounded border border-brand-500/40 bg-brand-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-brand-500">
            agent
          </span>
        )}
        {info && (
          <span className="text-[10px] text-neutral-500">
            {info.cols}×{info.rows} · {info.alive ? 'running' : 'stopped'}
          </span>
        )}
        {missing && (
          <span className="text-[10px] text-neutral-500">terminated</span>
        )}
        <div className="relative ml-auto">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-300 hover:bg-neutral-800"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded border border-neutral-800 bg-neutral-950 shadow-lg">
              <button
                onClick={() => void onTerminate()}
                disabled={!info || dispose.isPending}
                className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-900 disabled:opacity-50"
              >
                Terminate shell
              </button>
            </div>
          )}
        </div>
      </div>
      {err && <div className="border-b border-red-900 bg-red-950 px-3 py-1 text-[10px] text-red-300">{err}</div>}
      <div className="min-h-0 flex-1 bg-black">
        {missing ? (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            Shell terminated.
          </div>
        ) : (
          <XTermAttached key={shellId} shellId={shellId} />
        )}
      </div>
    </div>
  )
}
