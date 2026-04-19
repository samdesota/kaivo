import { useEffect, useState } from 'react'
import { trpc } from '../../../trpc'
import { extractTrpcMessage } from '../../../lib/utils'
import { FileTree } from '../file-tree'
import { ReposPanel } from '../repos'
import type { PaneContent } from '../shell/tab-state'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '../../../../server/trpc/router'

type RouterOutput = inferRouterOutputs<AppRouter>
type PortRow = RouterOutput['preview']['portsSnapshot'][number]

export function NewTabContent({
  sandboxId,
  onOpen,
}: {
  sandboxId: string
  onOpen: (content: PaneContent) => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <Section title="Quick actions">
        <div className="flex flex-wrap gap-2">
          <NewShellButton sandboxId={sandboxId} onOpen={onOpen} />
        </div>
      </Section>

      <Section title="Running shells">
        <ShellsList sandboxId={sandboxId} onOpen={onOpen} />
      </Section>

      <Section title="Running previews">
        <PreviewsList sandboxId={sandboxId} onOpen={onOpen} />
      </Section>

      <Section title="Repos">
        <ReposPanel sandboxId={sandboxId} />
      </Section>

      <Section title="Files">
        <FileTree
          sandboxId={sandboxId}
          onOpen={(path) => onOpen({ type: 'file', path })}
          activePath={null}
        />
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-neutral-800 px-4 py-3">
      <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
        {title}
      </h2>
      <div>{children}</div>
    </section>
  )
}

function NewShellButton({
  sandboxId,
  onOpen,
}: {
  sandboxId: string
  onOpen: (content: PaneContent) => void
}) {
  const utils = trpc.useUtils()
  const create = trpc.shell.create.useMutation()
  const [err, setErr] = useState<string | null>(null)

  async function onClick() {
    setErr(null)
    try {
      const info = await create.mutateAsync({ sandboxId })
      await utils.shell.list.invalidate({ sandboxId })
      onOpen({ type: 'shell', shellId: info.id })
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  return (
    <>
      <button
        onClick={() => void onClick()}
        disabled={create.isPending}
        className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-800 disabled:opacity-60"
      >
        {create.isPending ? 'Starting…' : '+ New shell'}
      </button>
      {err && <span className="text-[10px] text-red-400">{err}</span>}
    </>
  )
}

function ShellsList({
  sandboxId,
  onOpen,
}: {
  sandboxId: string
  onOpen: (content: PaneContent) => void
}) {
  const shells = trpc.shell.list.useQuery({ sandboxId }, { refetchInterval: 5_000 })
  const utils = trpc.useUtils()
  const dispose = trpc.shell.dispose.useMutation()
  const [err, setErr] = useState<string | null>(null)

  async function onTerminate(id: string) {
    setErr(null)
    try {
      await dispose.mutateAsync({ id })
      await utils.shell.list.invalidate({ sandboxId })
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  const list = shells.data ?? []
  if (list.length === 0) {
    return <p className="text-xs text-neutral-600">No shells running.</p>
  }
  return (
    <>
      <ul className="space-y-1">
        {list.map((s) => (
          <li
            key={s.id}
            className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs"
          >
            <span
              className={
                'h-1.5 w-1.5 shrink-0 rounded-full ' +
                (s.alive ? 'bg-emerald-500' : 'bg-neutral-600')
              }
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-neutral-200">shell {s.id.slice(-8)}</div>
              <div className="truncate text-[10px] text-neutral-500">
                cwd {s.cwd} · {s.cols}×{s.rows}
              </div>
            </div>
            <button
              onClick={() => onOpen({ type: 'shell', shellId: s.id })}
              className="rounded border border-neutral-700 bg-neutral-950 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-200 hover:bg-neutral-800"
            >
              open
            </button>
            <button
              onClick={() => void onTerminate(s.id)}
              disabled={dispose.isPending}
              className="rounded border border-neutral-800 bg-neutral-950 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400 hover:border-red-900 hover:text-red-400 disabled:opacity-60"
            >
              terminate
            </button>
          </li>
        ))}
      </ul>
      {err && <p className="mt-2 text-[10px] text-red-400">{err}</p>}
    </>
  )
}

function PreviewsList({
  sandboxId,
  onOpen,
}: {
  sandboxId: string
  onOpen: (content: PaneContent) => void
}) {
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

  if (ports.length === 0) {
    return <p className="text-xs text-neutral-600">No listening ports.</p>
  }
  return (
    <ul className="space-y-1">
      {ports.map((p) => (
        <li
          key={`${p.port}-${p.process ?? ''}`}
          className="flex items-center gap-2 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs"
        >
          <div className="min-w-0 flex-1">
            <div className="font-mono text-neutral-200">:{p.port}</div>
            <div className="truncate text-[10px] text-neutral-500">
              {p.process ?? 'unknown'} · {p.address}
            </div>
          </div>
          <button
            onClick={() => onOpen({ type: 'preview', port: p.port })}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-0.5 text-[10px] uppercase tracking-wide text-neutral-200 hover:bg-neutral-800"
          >
            open
          </button>
        </li>
      ))}
    </ul>
  )
}
