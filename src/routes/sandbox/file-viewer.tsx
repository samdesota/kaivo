import { useEffect, useState } from 'react'
import { trpc } from '../../trpc'
import { extractTrpcMessage } from '../../lib/utils'

export function FileViewer({ sandboxId, path }: { sandboxId: string; path: string }) {
  const read = trpc.fs.read.useQuery({ sandboxId, path })
  const utils = trpc.useUtils()
  const write = trpc.fs.write.useMutation()

  const [draft, setDraft] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(null)
    setWriteError(null)
  }, [path])

  if (read.isLoading) return <div className="p-4 text-neutral-500">Loading…</div>
  if (read.error) return <div className="p-4 text-red-400">{extractTrpcMessage(read.error)}</div>
  if (!read.data) return null

  if (read.data.tooLarge) {
    return (
      <div className="p-4 text-sm text-neutral-400">
        File is too large to display ({formatBytes(read.data.size)}). Limit is 5 MB.
      </div>
    )
  }
  if (read.data.binary) {
    return (
      <div className="p-4 text-sm text-neutral-400">
        Binary file ({formatBytes(read.data.size)}). Preview not supported.
      </div>
    )
  }

  const value = draft ?? read.data.content ?? ''
  const dirty = draft !== null && draft !== read.data.content

  async function onSave() {
    setWriteError(null)
    try {
      await write.mutateAsync({ sandboxId, path, content: draft ?? '' })
      setDraft(null)
      await utils.fs.read.invalidate({ sandboxId, path })
    } catch (err) {
      setWriteError(extractTrpcMessage(err))
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-950 px-3 py-1.5 text-xs">
        <span className="truncate text-neutral-400">{path}</span>
        <div className="flex items-center gap-2">
          {writeError && <span className="text-red-400">{writeError}</span>}
          {dirty && (
            <button
              onClick={() => void onSave()}
              disabled={write.isPending}
              className="rounded bg-brand-500 px-3 py-1 text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {write.isPending ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
      <textarea
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className="flex-1 resize-none bg-black p-3 font-mono text-sm leading-5 text-neutral-200 focus:outline-none"
      />
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
