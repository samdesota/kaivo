import { useState } from 'react'
import { envTrpc } from '../../../../env-trpc'
import { extractTrpcMessage } from '../../../../lib/utils'
import type { QuestionRequest, QuestionItem } from '../transcript-store'

export function QuestionBanner({
  req,
  sessionId,
}: {
  req: QuestionRequest
  sessionId: string
}) {
  const reply = envTrpc.agent.sessionAnswerQuestion.useMutation()
  const reject = envTrpc.agent.sessionRejectQuestion.useMutation()
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    req.questions.map(initialDraft),
  )
  const [err, setErr] = useState<string | null>(null)
  const busy = reply.isPending || reject.isPending

  function update(idx: number, patch: Partial<QuestionDraft>) {
    setDrafts((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)))
  }

  function isComplete(): boolean {
    return drafts.every((d, i) => {
      const q = req.questions[i]!
      const answer = collectAnswer(q, d)
      return answer.length > 0
    })
  }

  async function onSubmit() {
    setErr(null)
    const answers = drafts.map((d, i) => collectAnswer(req.questions[i]!, d))
    if (answers.some((a) => a.length === 0)) {
      setErr('Answer all questions first.')
      return
    }
    try {
      await reply.mutateAsync({ sessionId, requestId: req.id, answers })
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  async function onReject() {
    setErr(null)
    try {
      await reject.mutateAsync({ sessionId, requestId: req.id })
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  return (
    <div className="space-y-3 rounded border border-sky-500/40 bg-sky-500/5 p-3">
      <div className="text-[10px] uppercase tracking-wide text-sky-300">
        Agent is asking
      </div>
      {req.questions.map((q, i) => (
        <QuestionRow
          key={i}
          q={q}
          draft={drafts[i]!}
          onChange={(patch) => update(i, patch)}
          disabled={busy}
        />
      ))}
      {err && (
        <div className="rounded border border-red-900 bg-red-950/50 px-2 py-1 text-[11px] text-red-300">
          {err}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          onClick={() => void onReject()}
          disabled={busy}
          className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-60"
        >
          {reject.isPending ? 'Rejecting…' : 'Reject'}
        </button>
        <button
          onClick={() => void onSubmit()}
          disabled={busy || !isComplete()}
          className="rounded bg-sky-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-400 disabled:opacity-60"
        >
          {reply.isPending ? 'Sending…' : 'Send answer'}
        </button>
      </div>
    </div>
  )
}

interface QuestionDraft {
  selected: Set<string>
  custom: string
}

function initialDraft(_q: QuestionItem): QuestionDraft {
  return { selected: new Set(), custom: '' }
}

function collectAnswer(q: QuestionItem, d: QuestionDraft): string[] {
  const out: string[] = []
  for (const o of q.options ?? []) if (d.selected.has(o.label)) out.push(o.label)
  const trimmed = d.custom.trim()
  if (trimmed) out.push(trimmed)
  return out
}

function QuestionRow({
  q,
  draft,
  onChange,
  disabled,
}: {
  q: QuestionItem
  draft: QuestionDraft
  onChange: (patch: Partial<QuestionDraft>) => void
  disabled: boolean
}) {
  const hasOptions = (q.options ?? []).length > 0
  const allowCustom = q.custom !== false || !hasOptions
  const multiple = q.multiple === true

  function toggle(label: string) {
    const selected = new Set(draft.selected)
    if (multiple) {
      if (selected.has(label)) selected.delete(label)
      else selected.add(label)
    } else {
      selected.clear()
      selected.add(label)
    }
    onChange({ selected })
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-neutral-100">{q.question}</div>
      {hasOptions && (
        <div className="flex flex-wrap gap-1.5">
          {q.options.map((o) => {
            const active = draft.selected.has(o.label)
            return (
              <button
                key={o.label}
                onClick={() => toggle(o.label)}
                disabled={disabled}
                title={o.description}
                className={
                  'rounded border px-2 py-1 text-xs transition-colors ' +
                  (active
                    ? 'border-sky-400 bg-sky-500/20 text-neutral-100'
                    : 'border-neutral-700 bg-neutral-900 text-neutral-300 hover:bg-neutral-800') +
                  ' disabled:opacity-60'
                }
              >
                {o.label}
              </button>
            )
          })}
        </div>
      )}
      {allowCustom && (
        <textarea
          value={draft.custom}
          onChange={(e) => onChange({ custom: e.target.value })}
          disabled={disabled}
          placeholder={hasOptions ? 'Or type a custom answer…' : 'Type your answer…'}
          rows={2}
          className="w-full resize-none rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-sky-500/60 focus:outline-none disabled:opacity-60"
        />
      )}
    </div>
  )
}
