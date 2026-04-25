import { useEffect, useState } from 'react'
import { Modal } from '../../../components/ui'
import { envTrpc } from '../../../env-trpc'
import { extractTrpcMessage } from '../../../lib/utils'

/**
 * Folder picker for the new-session flow. Browses directories under the
 * env's $HOME (server-enforced) and returns the absolute path of the
 * selected folder. Defaults to home on open.
 */
export function FolderPickerModal({
  open,
  onClose,
  onSelect,
  busy,
}: {
  open: boolean
  onClose: () => void
  onSelect: (absPath: string) => void
  busy?: boolean
}) {
  // `null` while we haven't loaded once and don't know the home anchor;
  // `undefined` in the query tells the server "default to $HOME".
  const [path, setPath] = useState<string | undefined>(undefined)
  const browse = envTrpc.fs.browseHome.useQuery(
    { path },
    { enabled: open, refetchOnWindowFocus: false },
  )

  // Reset to "home" each time the modal re-opens so the user starts in a
  // predictable place rather than wherever they last left off.
  useEffect(() => {
    if (open) setPath(undefined)
  }, [open])

  const data = browse.data
  const err = browse.error ? extractTrpcMessage(browse.error) : null

  return (
    <Modal open={open} onClose={onClose} title="Choose working folder" widthClass="max-w-lg">
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => setPath(undefined)}
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800"
          >
            ~ home
          </button>
          <button
            type="button"
            onClick={() => data?.parent && setPath(data.parent)}
            disabled={!data?.parent}
            className="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
          >
            ↑ up
          </button>
          <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-neutral-400">
            {data?.path ?? '…'}
          </div>
        </div>

        <div className="max-h-80 overflow-auto rounded border border-neutral-800 bg-neutral-900/40">
          {browse.isLoading && (
            <div className="px-3 py-2 text-xs text-neutral-500">Loading…</div>
          )}
          {err && (
            <div className="px-3 py-2 text-xs text-red-300">{err}</div>
          )}
          {data && data.dirs.length === 0 && !browse.isLoading && (
            <div className="px-3 py-2 text-xs text-neutral-500">(no subdirectories)</div>
          )}
          {data?.dirs.map((d) => (
            <button
              key={d.path}
              type="button"
              onDoubleClick={() => setPath(d.path)}
              onClick={() => setPath(d.path)}
              className="flex w-full items-center gap-2 border-b border-neutral-900 px-3 py-1.5 text-left text-xs text-neutral-200 last:border-b-0 hover:bg-neutral-900"
              title={d.path}
            >
              <span className="text-neutral-500">📁</span>
              <span className="truncate">{d.name}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="truncate font-mono text-[11px] text-neutral-500">
            Selected: {data?.path ?? '…'}
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => data && onSelect(data.path)}
              disabled={!data || busy}
              className="rounded bg-brand-500 px-3 py-1 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-60"
            >
              {busy ? 'Starting…' : 'Use this folder'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
