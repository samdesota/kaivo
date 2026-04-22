import { useEffect, useRef, useState } from 'react'
import { trpc } from '../../../trpc'

/**
 * Compact model picker shown in the session pane header. Lists every model
 * exposed by OpenCode's configured providers; selecting one stores the
 * choice server-side on the session (in-memory) so every subsequent
 * message goes to that model until changed.
 *
 * "Default" row clears the override and falls back to OpenCode's own
 * default, shown inline.
 */
export function ModelPicker({
  sandboxId,
  sessionId,
}: {
  sandboxId: string
  sessionId: string
}) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useRef<HTMLDivElement | null>(null)

  const list = trpc.agent.listModels.useQuery(
    { sandboxId },
    { staleTime: 60_000, refetchOnWindowFocus: false },
  )
  const current = trpc.agent.sessionGetModel.useQuery(
    { sessionId },
    { staleTime: 0 },
  )
  const setModel = trpc.agent.sessionSetModel.useMutation()
  const utils = trpc.useUtils()

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const currentLabel = current.data
    ? `${current.data.providerID}/${current.data.modelID}`
    : list.data?.defaultProviderID && list.data?.defaultModelID
      ? `${list.data.defaultProviderID}/${list.data.defaultModelID} (default)`
      : 'default'

  const filtered = (list.data?.models ?? []).filter((m) =>
    m.label.toLowerCase().includes(filter.toLowerCase()),
  )

  async function pick(providerID: string | null, modelID: string | null) {
    await setModel.mutateAsync({ sessionId, providerID, modelID })
    await utils.agent.sessionGetModel.invalidate({ sessionId })
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-900"
        title="Pick model for this session"
      >
        <span className="text-neutral-500">model:</span>
        <span className="max-w-[220px] truncate font-mono">{currentLabel}</span>
        <span className="text-neutral-500">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-96 rounded border border-neutral-800 bg-neutral-950 shadow-lg">
          <input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter models…"
            className="block w-full rounded-t border-b border-neutral-800 bg-neutral-950 px-3 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
          />
          <div className="max-h-80 overflow-auto">
            <button
              onClick={() => void pick(null, null)}
              className={
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-neutral-900 ' +
                (!current.data ? 'bg-neutral-900/60 text-neutral-100' : 'text-neutral-400')
              }
            >
              <span className="font-mono">default</span>
              {list.data?.defaultProviderID && list.data?.defaultModelID && (
                <span className="ml-auto font-mono text-[10px] text-neutral-500">
                  {list.data.defaultProviderID}/{list.data.defaultModelID}
                </span>
              )}
            </button>
            {list.isLoading && (
              <div className="px-3 py-2 text-xs text-neutral-500">Loading models…</div>
            )}
            {filtered.map((m) => {
              const active =
                current.data?.providerID === m.providerID &&
                current.data?.modelID === m.modelID
              return (
                <button
                  key={m.label}
                  onClick={() => void pick(m.providerID, m.modelID)}
                  className={
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-neutral-900 ' +
                    (active ? 'bg-neutral-900/60 text-neutral-100' : 'text-neutral-300')
                  }
                >
                  <span className="font-mono text-neutral-100">{m.modelID}</span>
                  <span className="ml-auto font-mono text-[10px] text-neutral-500">{m.providerID}</span>
                </button>
              )
            })}
            {list.data && filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-neutral-500">No matches.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
