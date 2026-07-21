import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Lock, Unlock } from 'lucide-react'
import type { BundledLanguage, ThemedToken } from 'shiki'
import { useOpenState } from './open-state'
import { DisclosureBody } from './disclosure'
import { parseUnifiedDiff, type DiffFileMetadata, type ParsedDiffFile, type ParsedDiffLine } from './diff-model'

type TokenMap = Record<string, ThemedToken[][]>

const shikiTheme = 'github-dark-default'
const defaultLargeDiffLineLimit = 500

export function DiffView({
  diff,
  onOpenFile,
  unbounded = false,
  hideLargeDiffs = false,
  fileExpansion,
  onFileExpansionChange,
  files: fileMetadata,
  truncated = false,
  selectedFileId,
}: {
  diff: string
  onOpenFile?: (path: string) => void
  unbounded?: boolean
  hideLargeDiffs?: boolean
  fileExpansion?: Readonly<Record<string, boolean>>
  onFileExpansionChange?: (fileId: string, open: boolean) => void
  files?: readonly DiffFileMetadata[]
  truncated?: boolean
  selectedFileId?: string | null
}) {
  const files = useMemo(() => parseUnifiedDiff(diff, fileMetadata, truncated), [diff, fileMetadata, truncated])
  const [tokens, setTokens] = useState<TokenMap>({})
  const [revealedFiles, setRevealedFiles] = useState<Set<string>>(() => new Set())
  const visibleFiles = useMemo(
    () => files.filter((file) => (fileExpansion?.[file.id] ?? true) && (!hideLargeDiffs || file.lines.length <= defaultLargeDiffLineLimit || revealedFiles.has(file.id))),
    [fileExpansion, files, hideLargeDiffs, revealedFiles],
  )

  useEffect(() => {
    if (!selectedFileId) return
    const element = document.getElementById(sectionDomId(selectedFileId))
    if (!element) return
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    element.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
  }, [selectedFileId])

  useEffect(() => {
    let cancelled = false
    async function highlight() {
      const { codeToTokens } = await import('shiki')
      setTokens({})
      for (const file of visibleFiles) {
          const language = languageForPath(file.path)
          if (language === 'text' || file.lines.length === 0) continue
          const code = file.lines.map((line) => codeText(line)).join('\n')
          try {
            const result = await codeToTokens(code, {
              lang: language,
              theme: shikiTheme,
              tokenizeMaxLineLength: 500,
            })
            if (!cancelled) setTokens((current) => ({ ...current, [file.id]: result.tokens }))
          } catch {
            // Keep the diff usable if Shiki does not have a grammar for this file.
          }
          await yieldToBrowser()
      }
    }
    void highlight()
    return () => {
      cancelled = true
    }
  }, [visibleFiles])

  if (files.length === 0) {
    return <div className="p-3 font-mono text-[11px] italic text-help">No changes.</div>
  }

  return (
    <div className="font-mono text-[11px] leading-5">
      {files.map((file) => (
        <DiffFileSection
          key={file.id}
          file={file}
          tokens={tokens[file.id]}
          onOpenFile={onOpenFile}
          unbounded={unbounded}
          largeDiffHidden={hideLargeDiffs && file.lines.length > defaultLargeDiffLineLimit && !revealedFiles.has(file.id)}
          onReveal={() => setRevealedFiles((current) => new Set(current).add(file.id))}
          controlledOpen={fileExpansion?.[file.id]}
          onOpenChange={onFileExpansionChange}
          selected={file.id === selectedFileId}
        />
      ))}
    </div>
  )
}

function DiffFileSection({
  file,
  tokens,
  onOpenFile,
  unbounded,
  largeDiffHidden,
  onReveal,
  controlledOpen,
  onOpenChange,
  selected,
}: {
  file: ParsedDiffFile & { language?: BundledLanguage | 'text' }
  tokens?: ThemedToken[][]
  onOpenFile?: (path: string) => void
  unbounded: boolean
  largeDiffHidden: boolean
  onReveal: () => void
  controlledOpen?: boolean
  onOpenChange?: (fileId: string, open: boolean) => void
  selected: boolean
}) {
  const [internalOpen, setInternalOpen] = useOpenState(`diff-file:${file.id}`, true)
  const open = controlledOpen ?? internalOpen
  const setOpen = (next: boolean | ((current: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(open) : next
    if (onOpenChange) onOpenChange(file.id, value)
    else setInternalOpen(value)
  }
  const [scrollLocked, setScrollLocked] = useState(true)
  const [hasScrollableContent, setHasScrollableContent] = useState(false)

  useEffect(() => {
    setScrollLocked(true)
    setHasScrollableContent(false)
  }, [file.id])

  return (
    <section id={sectionDomId(file.id)} data-diff-file-id={file.id} className={`scroll-mt-1 border-b border-neutral-900/60 last:border-b-0 ${selected ? 'ring-1 ring-inset ring-sky-800/60' : ''}`}>
      <div className="sticky top-0 z-10 backdrop-blur">
        <div className="flex min-w-0 w-full items-center gap-2 rounded py-0.5 text-left hover:bg-neutral-900/40">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex shrink-0 items-center justify-center text-left"
            title={open ? 'Collapse file diff' : 'Expand file diff'}
            aria-label={open ? `Collapse ${file.path} diff` : `Expand ${file.path} diff`}
          >
            <span className="inline-flex w-3 justify-center font-mono text-ui-muted">
              {open ? '▾' : '▸'}
            </span>
          </button>
          {onOpenFile ? (
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left text-content-default hover:underline focus:underline focus:outline-none"
              title={file.path}
              onClick={() => onOpenFile(file.path)}
            >
              {file.path}
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate text-content-default" title={file.path}>
              {file.path}
            </span>
          )}
          {file.binary && <span className="text-[10px] uppercase text-amber-300">Binary</span>}
          {!file.binary && languageForPath(file.path) !== 'text' && <span className="text-[10px] text-ui-muted">{languageForPath(file.path)}</span>}
          <span className="flex shrink-0 items-center gap-1.5 pr-1">
            <LineDiffCount added={file.additions} deleted={file.deletions} />
            {!unbounded && hasScrollableContent && (
              <button
                type="button"
                title={scrollLocked ? 'Scroll locked' : 'Scroll unlocked'}
                aria-label={scrollLocked ? 'Scroll locked' : 'Scroll unlocked'}
                onClick={() => setScrollLocked((locked) => !locked)}
                className="rounded p-0.5 text-ui-muted hover:bg-neutral-800 hover:text-content-default"
              >
                {scrollLocked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
              </button>
            )}
          </span>
        </div>
      </div>
      {open && (
        <DisclosureBody>
          {file.binary ? (
            <div className="py-3 text-help">Binary file changed. No text diff is available.</div>
          ) : largeDiffHidden ? (
            <div className="flex items-center gap-2 py-3 text-help">
               <span>Large diff hidden ({((file.additions ?? 0) + (file.deletions ?? 0)).toLocaleString()} changed lines).</span>
              <button
                type="button"
                className="rounded border border-neutral-700 px-2 py-0.5 text-content-default hover:bg-neutral-800"
                onClick={onReveal}
              >
                Show diff
              </button>
            </div>
          ) : (
            <LockedDiffScroll
              unbounded={unbounded}
              scrollLocked={scrollLocked}
              setScrollLocked={setScrollLocked}
              onScrollableContentChange={setHasScrollableContent}
            >
              {file.lines.length > 0 ? (
                <div className="py-1">
                  {file.lines.map((line, index) => (
                    <DiffLineView
                      key={index}
                      line={line}
                      tokens={tokens?.[index]}
                    />
                  ))}
                </div>
              ) : (
                <div className="py-1 font-mono text-[11px] text-help">
                   {file.status === 'deleted' ? 'File deleted.' : file.status === 'renamed' ? 'File renamed without line changes.' : 'No line changes shown.'}
                </div>
              )}
            </LockedDiffScroll>
          )}
          {file.incomplete && <div className="border-t border-amber-900/50 py-2 text-amber-300">This file section may be incomplete because the patch was truncated.</div>}
        </DisclosureBody>
      )}
    </section>
  )
}

function LockedDiffScroll({
  children,
  unbounded,
  scrollLocked,
  setScrollLocked,
  onScrollableContentChange,
}: {
  children: ReactNode
  unbounded: boolean
  scrollLocked: boolean
  setScrollLocked: (locked: boolean) => void
  onScrollableContentChange: (hasScrollableContent: boolean) => void
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return

    function updateScrollableContent() {
      if (!el) return
      onScrollableContentChange(
        el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
      )
    }

    updateScrollableContent()
    if (typeof ResizeObserver === 'undefined') return
    const resizeObserver = new ResizeObserver(updateScrollableContent)
    resizeObserver.observe(el)
    for (const child of Array.from(el.children)) resizeObserver.observe(child)
    return () => resizeObserver.disconnect()
  }, [children, onScrollableContentChange])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || !scrollLocked) return
    el.scrollTop = 0
    el.scrollLeft = 0
  }, [scrollLocked])

  return (
    <div>
      <div
        ref={scrollRef}
        onClick={() => {
          if (scrollLocked) setScrollLocked(false)
        }}
        className={unbounded ? 'overflow-x-auto' : `max-h-[32rem] ${scrollLocked ? 'overflow-hidden' : 'overflow-auto'}`}
      >
        {children}
      </div>
    </div>
  )
}

function codeText(line: ParsedDiffLine): string {
  if (line.kind === 'add' || line.kind === 'del') return line.text.slice(1)
  if (line.kind === 'ctx') return line.text.startsWith(' ') ? line.text.slice(1) : line.text
  return ''
}

function DiffLineView({ line, tokens }: { line: ParsedDiffLine; tokens?: ThemedToken[] }) {
  if (line.kind === 'hunk') {
    return <div className="px-3 py-0.5 text-[10px] text-sky-300/80">{line.text}</div>
  }
  if (line.kind === 'meta') {
    return <div className="px-3 py-0.5 text-[10px] text-ui-muted">{line.text}</div>
  }

  const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
  const text = codeText(line)
  const rowClass =
    line.kind === 'add'
      ? 'bg-emerald-500/[0.08]'
      : line.kind === 'del'
        ? 'bg-red-500/[0.08]'
        : 'hover:bg-white/[0.025]'
  const gutterClass =
    line.kind === 'add'
      ? 'text-emerald-300/80'
      : line.kind === 'del'
        ? 'text-red-300/80'
        : 'text-neutral-700'

  return (
    <div className={`grid grid-cols-[2rem_minmax(0,1fr)] ${rowClass}`}>
      <span className={`select-none text-center ${gutterClass}`}>{marker}</span>
      <span className="whitespace-pre pr-3 text-content-default">
        {tokens && tokens.length > 0 ? <TokenSpans tokens={tokens} /> : text || ' '}
      </span>
    </div>
  )
}

function TokenSpans({ tokens }: { tokens: ThemedToken[] }) {
  return (
    <>
      {tokens.map((token, index) => (
        <span key={`${index}:${token.offset}`} style={tokenStyle(token)}>
          {token.content}
        </span>
      ))}
    </>
  )
}

function tokenStyle(token: ThemedToken) {
  return token.color ? { color: token.color } : undefined
}

function LineDiffCount({ added, deleted }: { added: number | null; deleted: number | null }) {
  if (added === null || deleted === null || (added === 0 && deleted === 0)) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums">
      {added > 0 && <span className="text-emerald-300">+{added}</span>}
      {deleted > 0 && <span className="text-red-300">-{deleted}</span>}
    </span>
  )
}

function sectionDomId(fileId: string): string {
  return `diff-file-${encodeURIComponent(fileId).replaceAll('%', '_')}`
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function languageForPath(path: string): BundledLanguage | 'text' {
  const filename = path.split('/').pop()?.toLowerCase() ?? ''
  if (filename === 'dockerfile') return 'docker'
  if (filename === 'makefile') return 'make'

  const ext = filename.split('.').pop() ?? ''
  const map: Record<string, BundledLanguage> = {
    astro: 'astro',
    c: 'c',
    cc: 'cpp',
    cpp: 'cpp',
    cs: 'csharp',
    css: 'css',
    go: 'go',
    h: 'c',
    hbs: 'handlebars',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsonc: 'jsonc',
    jsx: 'jsx',
    kt: 'kotlin',
    less: 'less',
    lua: 'lua',
    md: 'markdown',
    mdx: 'mdx',
    php: 'php',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sass: 'sass',
    scss: 'scss',
    sh: 'shellscript',
    sql: 'sql',
    svelte: 'svelte',
    swift: 'swift',
    toml: 'toml',
    ts: 'typescript',
    tsx: 'tsx',
    vue: 'vue',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml',
    zig: 'zig',
  }
  return map[ext] ?? 'text'
}
