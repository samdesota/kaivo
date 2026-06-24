import type { SessionErrorPart } from '../transcript-store'

export function ErrorPart({ part }: { part: SessionErrorPart }) {
  return (
    <div className="rounded-lg border border-red-900/70 bg-red-950/25 px-3 py-2 text-sm shadow-sm">
      <div className="mb-1 flex items-center gap-2 font-medium text-red-200">
        <span className="h-2 w-2 rounded-full bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.7)]" aria-hidden="true" />
        <span>{part.title || 'Agent error'}</span>
      </div>
      <div className="whitespace-pre-wrap text-xs leading-relaxed text-red-100/90 [overflow-wrap:anywhere]">
        {part.message || 'The agent hit an error and stopped.'}
      </div>
    </div>
  )
}
