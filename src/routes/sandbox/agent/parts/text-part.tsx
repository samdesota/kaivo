import type { Part } from '../transcript-store'

export function TextPart({ part, role }: { part: Part; role: string }) {
  const text = (part as { text?: string }).text ?? ''
  const running = !(part as { time?: { end?: number } }).time?.end
  return (
    <div
      className={
        'whitespace-pre-wrap text-sm leading-relaxed ' +
        (role === 'user' ? 'text-neutral-300' : 'text-neutral-100')
      }
    >
      {text}
      {running && role !== 'user' && (
        <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-neutral-400 align-text-bottom" />
      )}
    </div>
  )
}
