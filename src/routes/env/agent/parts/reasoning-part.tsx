import { useState } from 'react'
import type { Part } from '../transcript-store'

export function ReasoningPart({ part }: { part: Part }) {
  const [open, setOpen] = useState(false)
  const text = (part as { text?: string }).text ?? ''
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40 p-2 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-neutral-400 hover:text-neutral-200"
      >
        <span className="font-mono">{open ? '▾' : '▸'}</span>
        <span className="italic">Thinking{text ? ` (${text.length} chars)` : ''}</span>
      </button>
      {open && (
        <pre className="mt-2 whitespace-pre-wrap text-[11px] leading-snug text-neutral-500">
          {text}
        </pre>
      )}
    </div>
  )
}
