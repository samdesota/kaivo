import { envTrpc } from '../../../env-trpc'
import { XTermAttached } from '../xterm-attached'

interface ShellRow {
  id: string
  alive: boolean
  cols: number
  rows: number
  cwd: string
  ownerKind?: string
  title?: string | null
}

export function ShellTabContent({
  shellId,
  workspaceId,
}: {
  shellId: string
  workspaceId?: string
}) {
  const shellListInput = workspaceId ? { workspaceId } : undefined
  const shells = envTrpc.shell.list.useQuery(shellListInput, { refetchInterval: 5_000 })

  const list = (shells.data ?? []) as ShellRow[]
  const info = list.find((s) => s.id === shellId)
  const terminated = info?.alive === false

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-neutral-975 [--shell-pad:0.5rem]">
      <div className="min-h-0 flex-1 bg-neutral-975 p-[var(--shell-pad)]">
        {terminated ? (
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
