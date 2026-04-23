import { trpc } from '../../../../trpc'
import { extractTrpcMessage } from '../../../../lib/utils'
import type { Part } from '../transcript-store'
import { DiffView } from './diff-view'
import { useOpenState } from './open-state'

export function PatchPart({ part, sandboxId }: { part: Part; sandboxId: string }) {
  const [open, setOpen] = useOpenState(`patch:${part.id}`, false)
  const p = part as { files?: string[]; hash?: string }
  const files = p.files ?? []
  const diff = trpc.fs.diff.useQuery(
    { sandboxId, paths: files.length > 0 ? files : undefined },
    { enabled: open, staleTime: 0, refetchOnWindowFocus: false },
  )
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
        <button
          onClick={(e) => {
            e.stopPropagation()
            void diff.refetch()
          }}
          className="ml-auto rounded px-1 text-[10px] text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          title="Refresh diff"
        >
          ↻
        </button>
      </button>
      {open && (
        <div className="max-h-96 overflow-auto border-t border-neutral-800 bg-neutral-950">
          {files.length > 0 && (
            <ul className="border-b border-neutral-800 px-2 py-1 text-[10px]">
              {files.map((f) => (
                <li key={f} className="font-mono text-neutral-400">
                  {f}
                </li>
              ))}
            </ul>
          )}
          {diff.isLoading && <div className="p-2 text-neutral-500">Loading diff…</div>}
          {diff.error && (
            <div className="p-2 text-red-400">
              Diff failed: {extractTrpcMessage(diff.error)}
            </div>
          )}
          {diff.data && <DiffView diff={diff.data.diff} />}
        </div>
      )}
    </div>
  )
}
