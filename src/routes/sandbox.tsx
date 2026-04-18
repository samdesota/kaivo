import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useNavigate } from '@tanstack/react-router'
import { trpc } from '../trpc'
import { extractTrpcMessage } from '../lib/utils'
import { Terminal } from './sandbox/terminal'
import { FileTree } from './sandbox/file-tree'
import { FileViewer } from './sandbox/file-viewer'

export function SandboxDetailPage() {
  const { id } = useParams({ from: '/sandbox/$id' })
  const navigate = useNavigate()
  const sb = trpc.sandbox.get.useQuery({ id }, { refetchInterval: 5_000 })
  const [openPath, setOpenPath] = useState<string | null>(null)

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
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-brand-500 hover:underline">←</Link>
          <h1 className="text-sm font-semibold">{sb.data.name}</h1>
          <span className="text-xs text-neutral-500">
            {sb.data.id} · {sb.data.status} {sb.data.running ? '(running)' : '(stopped)'}
          </span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-72 shrink-0 overflow-auto border-r border-neutral-800">
          <FileTree
            sandboxId={id}
            onOpen={(p) => setOpenPath(p)}
            activePath={openPath}
          />
        </aside>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-[40%] flex-1 overflow-auto border-b border-neutral-800">
            {openPath ? (
              <FileViewer sandboxId={id} path={openPath} />
            ) : (
              <div className="p-6 text-sm text-neutral-500">Select a file to view.</div>
            )}
          </div>
          <TerminalPane sandboxId={id} running={sb.data.running} />
        </div>
      </div>
    </div>
  )
}

function TerminalPane({ sandboxId, running }: { sandboxId: string; running: boolean }) {
  const utils = trpc.useUtils()
  const shells = trpc.shell.list.useQuery({ sandboxId }, { refetchInterval: 5_000 })
  const create = trpc.shell.create.useMutation()
  const [activeShell, setActiveShell] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const didAutoCreateRef = useRef(false)

  const activeId = useMemo(() => {
    if (activeShell) return activeShell
    return shells.data?.[0]?.id ?? null
  }, [activeShell, shells.data])

  useEffect(() => {
    if (!running || didAutoCreateRef.current) return
    if (shells.isLoading) return
    if (shells.data && shells.data.length === 0 && !create.isPending) {
      didAutoCreateRef.current = true
      create
        .mutateAsync({ sandboxId })
        .then((info) => {
          setActiveShell(info.id)
          void utils.shell.list.invalidate({ sandboxId })
        })
        .catch((err) => setCreateError(extractTrpcMessage(err)))
    }
  }, [running, shells.isLoading, shells.data, create, sandboxId, utils])

  async function onNewShell() {
    setCreateError(null)
    try {
      const info = await create.mutateAsync({ sandboxId })
      setActiveShell(info.id)
      await utils.shell.list.invalidate({ sandboxId })
    } catch (err) {
      setCreateError(extractTrpcMessage(err))
    }
  }

  if (!running) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-neutral-500">
        Sandbox is not running.
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-3 py-1.5">
        <span className="text-xs uppercase tracking-wide text-neutral-500">Terminal</span>
        <div className="flex gap-1">
          {(shells.data ?? []).map((s) => (
            <button
              key={s.id}
              onClick={() => setActiveShell(s.id)}
              className={
                'rounded px-2 py-0.5 text-xs ' +
                (s.id === activeId
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200')
              }
              title={s.id}
            >
              shell {s.id.slice(-6)}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {createError && <span className="text-xs text-red-400">{createError}</span>}
          <button
            onClick={() => void onNewShell()}
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs hover:bg-neutral-800"
            disabled={create.isPending}
          >
            + new shell
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 bg-black">
        {activeId ? (
          <Terminal key={activeId} shellId={activeId} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            No shell yet.
          </div>
        )}
      </div>
    </div>
  )
}
