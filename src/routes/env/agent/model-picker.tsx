import { useEffect, useMemo, useRef, useState } from 'react'
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

function fastBaseModelID(modelID: string): string {
  return modelID.endsWith('-fast') ? modelID.slice(0, -'-fast'.length) : modelID
}

function fastModelID(modelID: string): string {
  return `${fastBaseModelID(modelID)}-fast`
}

export function ModelEffortPicker({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const ref = useRef<HTMLDivElement | null>(null)
  const queryClient = useQueryClient()

  const list = envTrpc.agent.listModels.useQuery(undefined, {
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const current = envTrpc.agent.sessionGetModel.useQuery(
    { sessionId },
    { staleTime: 0 },
  )
  const setModel = envTrpc.agent.sessionSetModel.useMutation()
  const setVariant = envTrpc.agent.sessionSetModelVariant.useMutation()

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
  const selectedEffort = curr?.variant ?? null
  const currentModelLabel = curr?.providerID && curr.modelID
    ? `${curr.providerID}/${curr.modelID}`
    : lst?.defaultProviderID && lst?.defaultModelID
      ? `${lst.defaultProviderID}/${lst.defaultModelID}`
      : 'default'
  const effortLabel = selectedEffort
    ? reasoningEfforts.find((effort) => effort.value === selectedEffort)?.label ?? selectedEffort
    : 'default'
  const currentProviderID = curr?.providerID ?? lst?.defaultProviderID ?? null
  const currentModelID = curr?.modelID ?? lst?.defaultModelID ?? null
  const fastOption = useMemo(() => {
    if (!currentProviderID || !currentModelID || !lst?.models) return null
    const baseModelID = fastBaseModelID(currentModelID)
    const nextFastModelID = fastModelID(currentModelID)
    const hasBase = lst.models.some((m) => m.providerID === currentProviderID && m.modelID === baseModelID)
    const hasFast = lst.models.some((m) => m.providerID === currentProviderID && m.modelID === nextFastModelID)
    if (!hasBase || !hasFast) return null
    return {
      providerID: currentProviderID,
      baseModelID,
      fastModelID: nextFastModelID,
      enabled: currentModelID === nextFastModelID,
    }
  }, [currentModelID, currentProviderID, lst?.models])
  const buttonTitle = `${currentModelLabel} · ${effortLabel} effort${fastOption?.enabled ? ' · fast' : ''}`

  const filtered = useMemo(
    () => (lst?.models ?? []).filter((m) => m.label.toLowerCase().includes(filter.toLowerCase())),
    [filter, lst?.models],
  )

  async function invalidateCurrentModel() {
    await queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.sessionGetModel', { sessionId }) })
  }

  async function pickModel(providerID: string | null, modelID: string | null) {
    await setModel.mutateAsync({ sessionId, providerID, modelID })
    await invalidateCurrentModel()
  }

  async function pickEffort(next: ReasoningEffort | null) {
    await setVariant.mutateAsync({ sessionId, variant: next })
    await invalidateCurrentModel()
  }

  async function toggleFastMode() {
    if (!fastOption) return
    await pickModel(fastOption.providerID, fastOption.enabled ? fastOption.baseModelID : fastOption.fastModelID)
  }

  return (
    <div ref={ref} className="relative flex items-center gap-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-[22rem] items-center gap-1.5 rounded border border-neutral-800 bg-neutral-900/60 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100"
        title="Pick model and reasoning effort for this session"
      >
        <span
          className="inline-block max-w-36 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-content-strong"
          style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
          title={currentModelLabel}
        >
          {currentModelLabel}
        </span>
        <span className="text-ui-muted">·</span>
        <span className="font-mono text-content-strong">{effortLabel}</span>
        <span className="text-ui-muted">▾</span>
      </button>
      {fastOption && (
        <button
          type="button"
          aria-pressed={fastOption.enabled}
          onClick={() => void toggleFastMode()}
          disabled={setModel.isPending}
          className={
            'flex items-center gap-1 rounded border px-2 py-1 text-[11px] transition-colors disabled:opacity-50 ' +
            (fastOption.enabled
              ? 'border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/20'
              : 'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100')
          }
          title={fastOption.enabled ? 'Disable fast mode for this session' : 'Enable fast mode for this session'}
        >
          <span className="h-2 w-2 rounded-full border border-current bg-current opacity-80" />
          Fast
        </button>
      )}
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-1 grid w-[500px] max-w-[calc(100vw-2rem)] grid-cols-[minmax(0,1fr)_9rem] overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl">
          <div className="min-w-0 border-r border-neutral-800">
            <div className="border-b border-neutral-800 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-label">
              Model
            </div>
            <div>
              <input
                autoFocus
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter models..."
                className="block w-full bg-transparent px-3 py-2 text-xs text-content-strong placeholder:text-placeholder focus:outline-none"
              />
            </div>
            <div className="max-h-80 overflow-auto py-1">
              <ModelRow
                active={!curr?.providerID && !curr?.modelID}
                label={lst?.defaultProviderID && lst.defaultModelID ? `default (${lst.defaultProviderID}/${lst.defaultModelID})` : 'default'}
                disabled={setModel.isPending}
                onPick={() => void pickModel(null, null)}
              />
              {list.isLoading && <div className="px-3 py-2 text-xs text-help">Loading models...</div>}
              {filtered.map((m) => (
                <ModelRow
                  key={m.label}
                  active={curr?.providerID === m.providerID && curr?.modelID === m.modelID}
                  label={`${m.providerID}/${m.modelID}`}
                  disabled={setModel.isPending}
                  onPick={() => void pickModel(m.providerID, m.modelID)}
                />
              ))}
              {lst && filtered.length === 0 && <div className="px-3 py-2 text-xs text-help">No matches.</div>}
            </div>
          </div>
          <div className="min-w-0">
            <div className="border-b border-neutral-800 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-label">Effort</div>
            <div className="py-1">
              <EffortRow
                active={!selectedEffort}
                label="Default"
                disabled={setVariant.isPending}
                onPick={() => void pickEffort(null)}
              />
              {reasoningEfforts.map((effort) => (
                <EffortRow
                  key={effort.value}
                  active={selectedEffort === effort.value}
                  label={effort.label}
                  disabled={setVariant.isPending}
                  onPick={() => void pickEffort(effort.value)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      <span className="sr-only">{buttonTitle}</span>
    </div>
  )
}

function ModelRow({
  active,
  label,
  disabled,
  onPick,
}: {
  active: boolean
  label: string
  disabled: boolean
  onPick: () => void
}) {
  return (
    <button
      onClick={onPick}
      disabled={disabled}
      className={
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-neutral-900 disabled:opacity-50 ' +
        (active ? 'bg-neutral-800 text-content-strong' : 'text-content-default')
      }
    >
      <span className="min-w-0 flex-1 truncate text-left font-mono text-content-strong" title={label}>{label}</span>
      <span className="w-3 shrink-0 text-right text-[10px] text-content-strong">{active ? '✓' : ''}</span>
    </button>
  )
}

function EffortRow({
  active,
  label,
  disabled,
  onPick,
}: {
  active: boolean
  label: string
  disabled: boolean
  onPick: () => void
}) {
  return (
    <button
      onClick={onPick}
      disabled={disabled}
      className={
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-neutral-900 disabled:opacity-50 ' +
        (active ? 'bg-neutral-800 text-content-strong' : 'text-content-default')
      }
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="w-3 shrink-0 text-right text-[10px] text-content-strong">{active ? '✓' : ''}</span>
    </button>
  )
}
