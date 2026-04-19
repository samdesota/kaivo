import type { Part } from '../transcript-store'

export function StepFinishPart({ part }: { part: Part }) {
  const p = part as {
    cost?: number
    tokens?: { input?: number; output?: number; reasoning?: number }
  }
  const cost = typeof p.cost === 'number' ? p.cost : null
  const tokens = p.tokens
  return (
    <div className="text-[10px] uppercase tracking-wide text-neutral-600">
      {cost !== null && <span>${cost.toFixed(4)}</span>}
      {cost !== null && tokens && <span> · </span>}
      {tokens && (
        <span>
          in {tokens.input ?? 0} · out {tokens.output ?? 0}
          {tokens.reasoning ? ` · think ${tokens.reasoning}` : ''}
        </span>
      )}
    </div>
  )
}
