import { useState } from 'react'
import type { Part } from '../transcript-store'

export function PatchPart({ part }: { part: Part }) {
  const [open, setOpen] = useState(false)
  const p = part as { files?: string[]; hash?: string }
  const files = p.files ?? []
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40 text-xs">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-neutral-900"
      >
        <span className="font-mono">{open ? '▾' : '▸'}</span>
        <span className="text-neutral-300">
          patch{files.length > 0 ? ` · ${files.length} file${files.length === 1 ? '' : 's'}` : ''}
        </span>
        {p.hash && <span className="font-mono text-neutral-600">{p.hash.slice(0, 7)}</span>}
      </button>
      {open && (
        <ul className="border-t border-neutral-800 p-2 text-[11px]">
          {files.map((f) => (
            <li key={f} className="font-mono text-neutral-400">
              {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
