import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Eye, FileText } from 'lucide-react'
import type { ReactNode } from 'react'
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
  '&': { backgroundColor: 'var(--color-neutral-950)' },
  '.cm-scroller': { backgroundColor: 'var(--color-neutral-950)' },
  '.cm-content': { backgroundColor: 'var(--color-neutral-950)' },
  '.cm-gutters': { backgroundColor: 'var(--color-neutral-950)', borderRightColor: 'var(--color-neutral-800)' },
  '.cm-gutter, .cm-gutterElement, .cm-activeLineGutter': { backgroundColor: 'var(--color-neutral-950)' },
})

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdown|mkdn)$/i.test(path)
}

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
  const [markdownMode, setMarkdownMode] = useState<'preview' | 'text'>(() => isMarkdownPath(path) ? 'preview' : 'text')
  const pendingSourceLineRef = useRef<number | null>(null)
  const getPreviewTopLineRef = useRef<() => number | null>(() => null)
  const getTextTopLineRef = useRef<() => number | null>(() => null)
  const prevPathRef = useRef(path)
  const markdown = isMarkdownPath(path)

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
    setMarkdownMode(isMarkdownPath(path) ? 'preview' : 'text')
    pendingSourceLineRef.current = null
  }, [path, setActiveEditorState])

  function setMarkdownModeAndPreserveScroll(nextMode: 'preview' | 'text') {
    pendingSourceLineRef.current = markdownMode === 'preview'
      ? getPreviewTopLineRef.current()
      : getTextTopLineRef.current()
    setMarkdownMode(nextMode)
  }

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

  if (read.isLoading) return <div className="h-full bg-neutral-975 p-4 text-help">Loading…</div>
  if (read.error && activeEditorState.draft === null) {
    return <div className="h-full bg-neutral-975 p-4 text-red-400">{extractTrpcMessage(read.error)}</div>
  }
  if (read.error) {
    return (
      <div className="flex h-full flex-col bg-neutral-975">
        <StaleFileBanner deleted onDiscardChanges={onDiscardChanges} onSave={() => void onSave()} isSaving={write.isPending} />
        <CodeMirrorPane value={activeEditorState.draft ?? ''} path={path} onChange={(nextDraft) => onChange(nextDraft, null)} />
        <FileViewerBar
          path={path}
          dirty
          writeError={writeError}
          isSaving={write.isPending}
          onSave={() => void onSave()}
        />
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
      <div className="h-full bg-neutral-975 p-4 text-sm text-ui-default">
        File is too large to display ({formatBytes(data.size ?? 0)}). Limit is 5 MB.
      </div>
    )
  }
  if (data.binary) {
    return (
      <div className="h-full bg-neutral-975 p-4 text-sm text-ui-default">
        Binary file ({formatBytes(data.size ?? 0)}). Preview not supported.
      </div>
    )
  }

  const value = activeEditorState.draft ?? data.content ?? ''
  const dirty = activeEditorState.draft !== null && activeEditorState.draft !== data.content
  const stale = isFileDraftStale(activeEditorState, data.mtime)

  return (
    <div className="flex h-full flex-col bg-neutral-975">
      {dirty && stale && (
        <StaleFileBanner onDiscardChanges={onDiscardChanges} onSave={() => void onSave()} isSaving={write.isPending} />
      )}
      {markdown && markdownMode === 'preview' ? (
        <MarkdownPreview
          value={value}
          targetSourceLine={pendingSourceLineRef.current}
          onTopLineReaderChange={(reader) => {
            getPreviewTopLineRef.current = reader
          }}
          onTargetSourceLineApplied={() => {
            pendingSourceLineRef.current = null
          }}
        />
      ) : (
        <CodeMirrorPane
          value={value}
          path={path}
          targetSourceLine={pendingSourceLineRef.current}
          onTopLineReaderChange={(reader) => {
            getTextTopLineRef.current = reader
          }}
          onTargetSourceLineApplied={() => {
            pendingSourceLineRef.current = null
          }}
          onChange={(nextDraft) => onChange(nextDraft, data.mtime)}
        />
      )}
      <FileViewerBar
        path={path}
        dirty={dirty}
        writeError={writeError}
        isSaving={write.isPending}
        onSave={() => void onSave()}
        markdownMode={markdown ? markdownMode : undefined}
        onMarkdownModeChange={setMarkdownModeAndPreserveScroll}
      />
    </div>
  )
}

function FileViewerBar({
  path,
  dirty,
  writeError,
  isSaving,
  onSave,
  markdownMode,
  onMarkdownModeChange,
}: {
  path: string
  dirty: boolean
  writeError: string | null
  isSaving: boolean
  onSave: () => void
  markdownMode?: 'preview' | 'text'
  onMarkdownModeChange?: (mode: 'preview' | 'text') => void
}) {
  const nextMarkdownMode = markdownMode === 'preview' ? 'text' : 'preview'
  const ToggleIcon = markdownMode === 'preview' ? FileText : Eye
  return (
    <div className="flex flex-none basis-8 items-center justify-between border-t border-neutral-800 bg-neutral-975 px-3 text-xs">
      <span className="truncate text-ui-default">{path}</span>
      <div className="flex items-center gap-2">
        {writeError && <span className="text-red-400">{writeError}</span>}
        {markdownMode && onMarkdownModeChange && (
          <button
            onClick={() => onMarkdownModeChange(nextMarkdownMode)}
            className="flex h-6 w-6 items-center justify-center rounded text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
            title={markdownMode === 'preview' ? 'Switch to text mode' : 'Switch to preview'}
            aria-label={markdownMode === 'preview' ? 'Switch to text mode' : 'Switch to preview'}
          >
            <ToggleIcon size={14} />
          </button>
        )}
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

function MarkdownPreview({
  value,
  targetSourceLine,
  onTopLineReaderChange,
  onTargetSourceLineApplied,
}: {
  value: string
  targetSourceLine: number | null
  onTopLineReaderChange: (reader: () => number | null) => void
  onTargetSourceLineApplied: () => void
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (targetSourceLine === null) return
    scrollPreviewToSourceLine(scrollerRef.current, targetSourceLine)
    onTargetSourceLineApplied()
  }, [targetSourceLine, onTargetSourceLineApplied])
  useEffect(() => {
    onTopLineReaderChange(() => getPreviewTopSourceLine(scrollerRef.current))
  }, [onTopLineReaderChange])
  return (
    <div
      ref={scrollerRef}
      className="min-h-0 flex-1 overflow-auto bg-neutral-975"
    >
      <div className="mx-auto max-w-4xl px-8 py-7 text-sm leading-relaxed text-content-strong">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
          {value}
        </ReactMarkdown>
      </div>
    </div>
  )
}

type MarkdownComponentProps = {
  children?: ReactNode
  node?: { position?: { start?: { line?: number } } }
}

function sourceLineProps(node: MarkdownComponentProps['node']): { 'data-source-line'?: number } {
  const line = node?.position?.start?.line
  return typeof line === 'number' ? { 'data-source-line': line } : {}
}

const markdownComponents = {
  h1: (p: MarkdownComponentProps) => <h1 {...sourceLineProps(p.node)} className="mt-0 mb-4 border-b border-neutral-800 pb-2 text-2xl font-semibold text-header-1">{p.children}</h1>,
  h2: (p: MarkdownComponentProps) => <h2 {...sourceLineProps(p.node)} className="mt-7 mb-3 border-b border-neutral-800/70 pb-1.5 text-xl font-semibold text-header-1">{p.children}</h2>,
  h3: (p: MarkdownComponentProps) => <h3 {...sourceLineProps(p.node)} className="mt-6 mb-2 text-lg font-semibold text-header-2">{p.children}</h3>,
  h4: (p: MarkdownComponentProps) => <h4 {...sourceLineProps(p.node)} className="mt-5 mb-2 text-base font-semibold text-header-2">{p.children}</h4>,
  p: (p: MarkdownComponentProps) => <p {...sourceLineProps(p.node)} className="my-3 first:mt-0 last:mb-0">{p.children}</p>,
  a: (p: MarkdownComponentProps & { href?: string }) => <a href={p.href} target="_blank" rel="noreferrer" className="text-blue-300 underline underline-offset-2 hover:text-blue-200">{p.children}</a>,
  ul: (p: MarkdownComponentProps) => <ul {...sourceLineProps(p.node)} className="my-3 ml-6 list-disc space-y-1 marker:text-ui-muted">{p.children}</ul>,
  ol: (p: MarkdownComponentProps) => <ol {...sourceLineProps(p.node)} className="my-3 ml-6 list-decimal space-y-1 marker:text-ui-muted">{p.children}</ol>,
  li: (p: MarkdownComponentProps) => <li {...sourceLineProps(p.node)} className="pl-1">{p.children}</li>,
  blockquote: (p: MarkdownComponentProps) => <blockquote {...sourceLineProps(p.node)} className="my-4 border-l-4 border-neutral-700 bg-neutral-950/50 py-1 pl-4 text-content-default">{p.children}</blockquote>,
  code: (p: MarkdownComponentProps & { className?: string }) => {
    if (!p.className) return <code className="rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[0.88em] text-content-strong">{p.children}</code>
    return <code {...sourceLineProps(p.node)} className={`${p.className} font-mono text-[13px]`}>{p.children}</code>
  },
  pre: (p: MarkdownComponentProps) => <pre {...sourceLineProps(p.node)} className="my-4 overflow-x-auto rounded-md border border-neutral-800 bg-neutral-950 p-4 text-[13px] leading-relaxed text-content-strong">{p.children}</pre>,
  table: (p: MarkdownComponentProps) => <div {...sourceLineProps(p.node)} className="my-4 overflow-x-auto"><table className="w-full border-collapse text-sm">{p.children}</table></div>,
  th: (p: MarkdownComponentProps) => <th className="border border-neutral-800 bg-neutral-950 px-3 py-1.5 text-left font-semibold text-header-2">{p.children}</th>,
  td: (p: MarkdownComponentProps) => <td className="border border-neutral-800 px-3 py-1.5 text-content-default">{p.children}</td>,
  hr: () => <hr className="my-6 border-neutral-800" />,
  img: (p: MarkdownComponentProps & { src?: string; alt?: string }) => <img {...sourceLineProps(p.node)} src={p.src} alt={p.alt ?? ''} className="my-4 max-w-full rounded border border-neutral-800" />,
  strong: (p: MarkdownComponentProps) => <strong className="font-semibold text-header-1">{p.children}</strong>,
}

function getPreviewAnchors(scroller: HTMLElement): Array<{ element: HTMLElement; line: number }> {
  return Array.from(scroller.querySelectorAll<HTMLElement>('[data-source-line]'))
    .map((element) => ({ element, line: Number(element.dataset.sourceLine) }))
    .filter((anchor) => Number.isFinite(anchor.line))
}

function getPreviewTopSourceLine(scroller: HTMLElement | null): number | null {
  if (!scroller) return null
  const scrollerTop = scroller.getBoundingClientRect().top
  const anchors = getPreviewAnchors(scroller)
  let best: { line: number; distance: number } | null = null
  for (const { element, line } of anchors) {
    const distance = Math.abs(element.getBoundingClientRect().top - scrollerTop)
    if (!best || distance < best.distance) best = { line, distance }
  }
  return best?.line ?? null
}

function scrollPreviewToSourceLine(scroller: HTMLElement | null, targetLine: number) {
  if (!scroller) return
  const anchors = getPreviewAnchors(scroller)
  const target = anchors.reduce<typeof anchors[number] | null>((best, anchor) => {
    if (!best) return anchor
    return Math.abs(anchor.line - targetLine) < Math.abs(best.line - targetLine) ? anchor : best
  }, null)
  if (!target) return
  const scrollerTop = scroller.getBoundingClientRect().top
  const targetTop = target.element.getBoundingClientRect().top
  scroller.scrollTop += targetTop - scrollerTop - 8
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
  targetSourceLine,
  onTopLineReaderChange,
  onTargetSourceLineApplied,
  onChange,
}: {
  value: string
  path: string
  targetSourceLine?: number | null
  onTopLineReaderChange?: (reader: () => number | null) => void
  onTargetSourceLineApplied?: () => void
  onChange: (v: string) => void
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const lang = useMemo(() => languageForPath(path), [path])
  const extensions = useMemo(
    () => [EditorView.lineWrapping, oneDark, workspaceEditorTheme, ...(lang ? [lang] : [])],
    [lang],
  )
  useLayoutEffect(() => {
    if (!targetSourceLine || !viewRef.current) return
    scrollEditorToSourceLine(viewRef.current, targetSourceLine)
    onTargetSourceLineApplied?.()
  }, [targetSourceLine, onTargetSourceLineApplied])
  useEffect(() => {
    onTopLineReaderChange?.(() => getEditorTopSourceLine(viewRef.current))
  }, [onTopLineReaderChange])
  return (
    <div ref={wrapperRef} className="min-h-0 flex-1 overflow-hidden bg-neutral-975">
      <CodeMirror
        value={value}
        height="100%"
        extensions={extensions}
        onCreateEditor={(view) => {
          viewRef.current = view
        }}
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

function getEditorTopSourceLine(view: EditorView | null): number | null {
  if (!view) return null
  const scrollerRect = view.scrollDOM.getBoundingClientRect()
  const pos = view.posAtCoords({ x: scrollerRect.left + 40, y: scrollerRect.top + 8 })
  if (pos === null) return view.state.doc.lineAt(view.viewport.from).number
  return view.state.doc.lineAt(pos).number
}

function scrollEditorToSourceLine(view: EditorView, sourceLine: number) {
  const lineNumber = Math.max(1, Math.min(sourceLine, view.state.doc.lines))
  const line = view.state.doc.line(lineNumber)
  view.dispatch({
    effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 8 }),
  })
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}
