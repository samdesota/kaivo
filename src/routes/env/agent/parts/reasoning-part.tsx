import { useState } from 'react'
import type { Part } from '../transcript-store'

export function ReasoningPart({ part }: { part: Part }) {
  const [open, setOpen] = useState(false)
  const text = (part as { text?: string }).text ?? ''
  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded py-0.5 text-left text-neutral-400 hover:bg-neutral-900/40 hover:text-neutral-200"
      >
        <span className="inline-flex w-3 justify-center font-mono text-neutral-500">{open ? '▾' : '▸'}</span>
        <span className="italic">Thinking{text ? ` (${text.length} chars)` : ''}</span>
      </button>
      {open && (
        <pre className="ml-[5px] whitespace-pre-wrap border-l border-neutral-800 pl-3 pt-1 text-[11px] leading-snug text-neutral-500">
          {text}
        </pre>
      )}
    </div>
  )
}
