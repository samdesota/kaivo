import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { envTrpc } from '../../env-trpc'
import { trpcQueryKey } from '../../lib/trpc-plain'
import { extractTrpcMessage } from '../../lib/utils'
import { languageForPath } from '../../lib/cm-language'

export function FileViewer({ path, absolute }: { path: string; absolute?: boolean }) {
  const read = envTrpc.fs.read.useQuery({ path, absolute })
  const queryClient = useQueryClient()
  const write = envTrpc.fs.write.useMutation()

  const [draft, setDraft] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(null)
    setWriteError(null)
  }, [path])

  if (read.isLoading) return <div className="p-4 text-neutral-500">Loading…</div>
  if (read.error) return <div className="p-4 text-red-400">{extractTrpcMessage(read.error)}</div>
  if (!read.data) return null

  const data = read.data as {
    tooLarge?: boolean
    binary?: boolean
    size?: number
    content?: string
  }

  if (data.tooLarge) {
    return (
      <div className="p-4 text-sm text-neutral-400">
        File is too large to display ({formatBytes(data.size ?? 0)}). Limit is 5 MB.
      </div>
    )
  }
  if (data.binary) {
    return (
      <div className="p-4 text-sm text-neutral-400">
        Binary file ({formatBytes(data.size ?? 0)}). Preview not supported.
      </div>
    )
  }

  const value = draft ?? data.content ?? ''
  const dirty = draft !== null && draft !== data.content

  async function onSave() {
    setWriteError(null)
    try {
      await write.mutateAsync({ path, content: draft ?? '', absolute })
      setDraft(null)
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('fs.read', { path, absolute }) })
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
      <CodeMirrorPane value={value} path={path} onChange={setDraft} />
    </div>
  )
}

function CodeMirrorPane({
  value,
  path,
  onChange,
}: {
  value: string
  path: string
  onChange: (v: string) => void
}) {
  const lang = useMemo(() => languageForPath(path), [path])
  const extensions = useMemo(
    () => [EditorView.lineWrapping, ...(lang ? [lang] : [])],
    [lang],
  )
  return (
    <div className="min-h-0 flex-1 overflow-hidden bg-[#282c34]">
      <CodeMirror
        value={value}
        height="100%"
        theme={oneDark}
        extensions={extensions}
        onChange={onChange}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          foldGutter: true,
          indentOnInput: true,
        }}
        style={{ height: '100%' }}
      />
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
