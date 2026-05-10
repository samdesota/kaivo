import { useState } from 'react'
import type { Part } from '../transcript-store'

export function FilePart({ part }: { part: Part }) {
  const [open, setOpen] = useState(false)
  const p = part as {
    filename?: string
    mime?: string
    url?: string
    source?: { path?: string }
  }
  const label = p.filename ?? p.source?.path ?? p.url ?? 'attachment'
  return (
    <div className="text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded py-0.5 text-left hover:bg-neutral-900/40"
      >
        <span className="inline-flex w-3 justify-center font-mono text-neutral-500">{open ? '▾' : '▸'}</span>
        <span className="truncate text-neutral-300">{label}</span>
        {p.mime && <span className="text-neutral-600">{p.mime}</span>}
      </button>
      {open && p.url && (
        <div className="ml-[5px] border-l border-neutral-800 pl-3 pt-1 text-[11px] text-neutral-500">
          <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-neutral-200 hover:underline">
            {p.url}
          </a>
        </div>
      )}
    </div>
  )
}
