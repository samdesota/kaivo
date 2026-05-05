import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { envTrpc } from '../../../env-trpc'
import { trpcQueryKey } from '../../../lib/trpc-plain'

interface ModelEntry {
  label: string
  providerID: string
  modelID: string
}
interface ModelList {
  models: ModelEntry[]
  defaultProviderID?: string | null
  defaultModelID?: string | null
}
interface SessionModel {
  providerID: string | null
  modelID: string | null
  variant?: ReasoningEffort | null
}

type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

const reasoningEfforts: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
]

export function ModelPicker({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useRef<HTMLDivElement | null>(null)

  const list = envTrpc.agent.listModels.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const current = envTrpc.agent.sessionGetModel.useQuery(
    { sessionId },
    { staleTime: 0 },
  )
  const setModel = envTrpc.agent.sessionSetModel.useMutation()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const curr = current.data as SessionModel | null | undefined
  const lst = list.data as ModelList | undefined
  const currentLabel = curr?.providerID && curr.modelID
    ? `${curr.providerID}/${curr.modelID}`
    : lst?.defaultProviderID && lst?.defaultModelID
      ? `${lst.defaultProviderID}/${lst.defaultModelID} (default)`
      : 'default'

  const filtered = (lst?.models ?? []).filter((m) =>
    m.label.toLowerCase().includes(filter.toLowerCase()),
  )

  async function pick(providerID: string | null, modelID: string | null) {
    await setModel.mutateAsync({ sessionId, providerID, modelID })
    await queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionGetModel', { sessionId }) })
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
                (!curr?.providerID && !curr?.modelID ? 'bg-neutral-900/60 text-neutral-100' : 'text-neutral-400')
              }
            >
              <span className="font-mono">default</span>
              {lst?.defaultProviderID && lst?.defaultModelID && (
                <span className="ml-auto font-mono text-[10px] text-neutral-500">
                  {lst.defaultProviderID}/{lst.defaultModelID}
                </span>
              )}
            </button>
            {list.isLoading && (
              <div className="px-3 py-2 text-xs text-neutral-500">Loading models…</div>
            )}
            {filtered.map((m) => {
              const active =
                curr?.providerID === m.providerID &&
                curr?.modelID === m.modelID
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
            {lst && filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-neutral-500">No matches.</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function ReasoningEffortPicker({ sessionId }: { sessionId: string }) {
  const current = envTrpc.agent.sessionGetModel.useQuery(
    { sessionId },
    { staleTime: 0 },
  )
  const setVariant = envTrpc.agent.sessionSetModelVariant.useMutation()
  const queryClient = useQueryClient()
  const curr = current.data as SessionModel | null | undefined
  const value = curr?.variant ?? ''

  async function pick(next: string) {
    await setVariant.mutateAsync({
      sessionId,
      variant: next ? (next as ReasoningEffort) : null,
    })
    await queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionGetModel', { sessionId }) })
  }

  return (
    <label className="flex items-center gap-1 rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[11px] text-neutral-300">
      <span className="text-neutral-500">effort:</span>
      <select
        value={value}
        onChange={(e) => void pick(e.target.value)}
        disabled={setVariant.isPending}
        title="Set OpenCode model variant / reasoning effort for this session"
        className="bg-transparent font-mono text-neutral-200 outline-none disabled:opacity-50"
      >
        <option className="bg-neutral-950" value="">default</option>
        {reasoningEfforts.map((effort) => (
          <option key={effort.value} className="bg-neutral-950" value={effort.value}>
            {effort.label}
          </option>
        ))}
      </select>
    </label>
  )
}
