import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { envTrpc } from '../../env-trpc'
import { trpcQueryKey } from '../../lib/trpc-plain'
import { extractTrpcMessage } from '../../lib/utils'
import { languageForPath } from '../../lib/cm-language'
import {
  emptyFileEditorState,
  isFileDraftStale,
  nextFileEditorStateForDraft,
  type FileEditorState,
} from './file-editor-state'
import { shouldRefreshFileForFsEvent } from './file-watch-match'

const workspaceEditorTheme = EditorView.theme({
  '&': { backgroundColor: '#111318' },
  '.cm-scroller': { backgroundColor: '#111318' },
  '.cm-content': { backgroundColor: '#111318' },
  '.cm-gutters': { backgroundColor: '#111318', borderRightColor: '#2c313a' },
  '.cm-gutter, .cm-gutterElement, .cm-activeLineGutter': { backgroundColor: '#111318' },
})

export function FileViewer({
  path,
  absolute,
  editorState,
  onEditorStateChange,
}: {
  path: string
  absolute?: boolean
  editorState?: FileEditorState
  onEditorStateChange?: (state: FileEditorState) => void
}) {
  const read = envTrpc.fs.read.useQuery({ path, absolute })
  const queryClient = useQueryClient()
  const write = envTrpc.fs.write.useMutation()

  const [localEditorState, setLocalEditorState] = useState<FileEditorState>(emptyFileEditorState)
  const [writeError, setWriteError] = useState<string | null>(null)
  const prevPathRef = useRef(path)

  const activeEditorState = editorState ?? localEditorState
  const setActiveEditorState = onEditorStateChange ?? setLocalEditorState

  envTrpc.fs.watch.useSubscription({ path, absolute }, {
    onData(evt) {
      if (shouldRefreshFileForFsEvent(evt, path, absolute)) void read.refetch()
    },
  })

  useEffect(() => {
    if (prevPathRef.current === path) return
    prevPathRef.current = path
    setActiveEditorState(emptyFileEditorState)
    setWriteError(null)
  }, [path, setActiveEditorState])

  async function onSave() {
    setWriteError(null)
    try {
      await write.mutateAsync({ path, content: activeEditorState.draft ?? '', absolute })
      setActiveEditorState(emptyFileEditorState)
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('fs.read', { path, absolute }) })
    } catch (err) {
      setWriteError(extractTrpcMessage(err))
    }
  }

  function onDiscardChanges() {
    setWriteError(null)
    setActiveEditorState(emptyFileEditorState)
  }

  function onChange(nextDraft: string, diskMtime?: string | Date | null) {
    setActiveEditorState(nextFileEditorStateForDraft(activeEditorState, nextDraft, diskMtime))
  }

  if (read.isLoading) return <div className="h-full bg-neutral-975 p-4 text-neutral-500">Loading…</div>
  if (read.error && activeEditorState.draft === null) {
    return <div className="h-full bg-neutral-975 p-4 text-red-400">{extractTrpcMessage(read.error)}</div>
  }
  if (read.error) {
    return (
      <div className="flex h-full flex-col bg-neutral-975">
        <FileViewerHeader
          path={path}
          dirty
          writeError={writeError}
          isSaving={write.isPending}
          onSave={() => void onSave()}
        />
        <StaleFileBanner deleted onDiscardChanges={onDiscardChanges} onSave={() => void onSave()} isSaving={write.isPending} />
        <CodeMirrorPane value={activeEditorState.draft ?? ''} path={path} onChange={(nextDraft) => onChange(nextDraft, null)} />
      </div>
    )
  }
  if (!read.data) return null

  const data = read.data as {
    tooLarge?: boolean
    binary?: boolean
    size?: number
    mtime?: string | Date
    content?: string
  }

  if (data.tooLarge) {
    return (
      <div className="h-full bg-neutral-975 p-4 text-sm text-neutral-400">
        File is too large to display ({formatBytes(data.size ?? 0)}). Limit is 5 MB.
      </div>
    )
  }
  if (data.binary) {
    return (
      <div className="h-full bg-neutral-975 p-4 text-sm text-neutral-400">
        Binary file ({formatBytes(data.size ?? 0)}). Preview not supported.
      </div>
    )
  }

  const value = activeEditorState.draft ?? data.content ?? ''
  const dirty = activeEditorState.draft !== null && activeEditorState.draft !== data.content
  const stale = isFileDraftStale(activeEditorState, data.mtime)

  return (
    <div className="flex h-full flex-col bg-neutral-975">
      <FileViewerHeader
        path={path}
        dirty={dirty}
        writeError={writeError}
        isSaving={write.isPending}
        onSave={() => void onSave()}
      />
      {dirty && stale && (
        <StaleFileBanner onDiscardChanges={onDiscardChanges} onSave={() => void onSave()} isSaving={write.isPending} />
      )}
      <CodeMirrorPane value={value} path={path} onChange={(nextDraft) => onChange(nextDraft, data.mtime)} />
    </div>
  )
}

function FileViewerHeader({
  path,
  dirty,
  writeError,
  isSaving,
  onSave,
}: {
  path: string
  dirty: boolean
  writeError: string | null
  isSaving: boolean
  onSave: () => void
}) {
  return (
    <div className="flex flex-none basis-8 items-center justify-between border-b border-neutral-800 bg-neutral-975 px-3 text-xs">
      <span className="truncate text-neutral-400">{path}</span>
      <div className="flex items-center gap-2">
        {writeError && <span className="text-red-400">{writeError}</span>}
        {dirty && (
          <button
            onClick={onSave}
            disabled={isSaving}
            className="rounded bg-neutral-700 px-3 py-1 text-white hover:bg-neutral-600 disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    </div>
  )
}

function StaleFileBanner({
  deleted = false,
  onDiscardChanges,
  onSave,
  isSaving,
}: {
  deleted?: boolean
  onDiscardChanges: () => void
  onSave: () => void
  isSaving: boolean
}) {
  return (
    <div className="flex flex-none items-center justify-between gap-3 border-b border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
      <span>{deleted ? 'The file was deleted on disk while you have local edits.' : 'The file on disk is newer than your local edits.'}</span>
      <div className="flex items-center gap-2">
        <button
          onClick={onDiscardChanges}
          className="rounded border border-amber-700/70 px-2 py-1 text-amber-100 hover:bg-amber-900/50"
        >
          Discard changes
        </button>
        <button
          onClick={onSave}
          disabled={isSaving}
          className="rounded bg-neutral-700 px-2 py-1 text-white hover:bg-neutral-600 disabled:opacity-50"
        >
          {isSaving ? 'Saving…' : 'Save'}
        </button>
      </div>
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
    () => [EditorView.lineWrapping, oneDark, workspaceEditorTheme, ...(lang ? [lang] : [])],
    [lang],
  )
  return (
    <div className="min-h-0 flex-1 overflow-hidden bg-neutral-975">
      <CodeMirror
        value={value}
        height="100%"
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
