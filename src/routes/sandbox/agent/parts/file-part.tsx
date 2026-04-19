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
    <div className="rounded border border-neutral-800 bg-neutral-900/40 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-neutral-900"
      >
        <span className="font-mono">{open ? '▾' : '▸'}</span>
        <span className="truncate text-neutral-300">{label}</span>
        {p.mime && <span className="text-neutral-600">{p.mime}</span>}
      </button>
      {open && p.url && (
        <div className="border-t border-neutral-800 p-2 text-[11px] text-neutral-500">
          <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-brand-500 hover:underline">
            {p.url}
          </a>
        </div>
      )}
    </div>
  )
}
