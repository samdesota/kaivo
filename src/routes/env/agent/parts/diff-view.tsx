import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Lock, Unlock } from 'lucide-react'
import type { BundledLanguage, ThemedToken } from 'shiki'
import { useOpenState } from './open-state'
import { DisclosureBody } from './disclosure'

type LineKind = 'hunk' | 'add' | 'del' | 'meta' | 'ctx'

interface DiffLine {
  kind: LineKind
  text: string
}

interface DiffFile {
  id: string
  action: string
  path: string
  language: BundledLanguage | 'text'
  lines: DiffLine[]
  added: number
  deleted: number
}

type TokenMap = Record<string, ThemedToken[][]>

const shikiTheme = 'github-dark-default'

export function DiffView({ diff }: { diff: string }) {
  const files = useMemo(() => parseDiff(diff), [diff])
  const [tokens, setTokens] = useState<TokenMap>({})

  useEffect(() => {
    let cancelled = false
    async function highlight() {
      const { codeToTokens } = await import('shiki')
      const next: TokenMap = {}
      await Promise.all(
        files.map(async (file) => {
          if (file.language === 'text' || file.lines.length === 0) return
          const code = file.lines.map((line) => codeText(line)).join('\n')
          try {
            const result = await codeToTokens(code, {
              lang: file.language,
              theme: shikiTheme,
              tokenizeMaxLineLength: 500,
            })
            next[file.id] = result.tokens
          } catch {
            // Keep the diff usable if Shiki does not have a grammar for this file.
          }
        }),
      )
      if (!cancelled) setTokens(next)
    }
    void highlight()
    return () => {
      cancelled = true
    }
  }, [files])

  if (files.length === 0) {
    return <div className="p-3 font-mono text-[11px] italic text-help">No changes.</div>
  }

  return (
    <div className="font-mono text-[11px] leading-5">
      {files.map((file) => (
        <DiffFileSection key={file.id} file={file} tokens={tokens[file.id]} />
      ))}
    </div>
  )
}

function DiffFileSection({ file, tokens }: { file: DiffFile; tokens?: ThemedToken[][] }) {
  const [open, setOpen] = useOpenState(`diff-file:${file.id}`, true)
  const [scrollLocked, setScrollLocked] = useState(true)
  const [hasScrollableContent, setHasScrollableContent] = useState(false)

  useEffect(() => {
    setScrollLocked(true)
    setHasScrollableContent(false)
  }, [file.id])

  return (
    <section className="border-b border-neutral-900/60 last:border-b-0">
      <div className="sticky top-0 z-10 backdrop-blur">
        <div className="flex min-w-0 w-full items-center gap-2 rounded py-0.5 text-left hover:bg-neutral-900/40">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <span className="inline-flex w-3 justify-center font-mono text-ui-muted">
              {open ? '▾' : '▸'}
            </span>
            <span className="min-w-0 flex-1 truncate text-content-default" title={file.path}>
              {file.path}
            </span>
            {file.language !== 'text' && <span className="text-[10px] text-ui-muted">{file.language}</span>}
          </button>
          <span className="flex shrink-0 items-center gap-1.5 pr-1">
            <LineDiffCount added={file.added} deleted={file.deleted} />
            {hasScrollableContent && (
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
          <LockedDiffScroll
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
                {file.action === 'Delete' ? 'File deleted.' : 'No line changes shown.'}
              </div>
            )}
          </LockedDiffScroll>
        </DisclosureBody>
      )}
    </section>
  )
}

function LockedDiffScroll({
  children,
  scrollLocked,
  setScrollLocked,
  onScrollableContentChange,
}: {
  children: ReactNode
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
        className={`max-h-[32rem] ${scrollLocked ? 'overflow-hidden' : 'overflow-auto'}`}
      >
        {children}
      </div>
    </div>
  )
}

function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  let pendingPath = ''

  for (const raw of diff.split('\n')) {
    if (raw === '*** Begin Patch' || raw === '*** End Patch') continue

    const patchFile = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(raw)
    if (patchFile) {
      current = createFile(files.length, patchFile[1]!, patchFile[2]!)
      files.push(current)
      continue
    }

    if (raw.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw)
      pendingPath = match?.[2] ?? match?.[1] ?? 'diff'
      current = createFile(files.length, 'Update', pendingPath)
      files.push(current)
      continue
    }

    if (!current) continue

    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).replace(/^b\//, '')
      if (path !== '/dev/null') {
        current.path = path
        current.language = languageForPath(path)
      }
      continue
    }

    if (raw.startsWith('--- ') || raw.startsWith('index ') || raw.startsWith('new file mode ') || raw.startsWith('deleted file mode ')) {
      current.lines.push({ kind: 'meta', text: raw })
      continue
    }

    if (raw.startsWith('*** Move to: ')) {
      current.path = raw.slice('*** Move to: '.length)
      current.language = languageForPath(current.path)
      continue
    }

    const kind = kindForLine(raw)
    if (kind === 'add') current.added += 1
    if (kind === 'del') current.deleted += 1
    current.lines.push({ kind, text: raw })
  }

  for (const file of files) {
    const last = file.lines[file.lines.length - 1]
    if (last?.kind === 'ctx' && last.text === '') file.lines.pop()
  }

  return files
}

function createFile(index: number, action: string, path: string): DiffFile {
  return {
    id: `${index}:${path}`,
    action,
    path,
    language: languageForPath(path),
    lines: [],
    added: 0,
    deleted: 0,
  }
}

function kindForLine(text: string): LineKind {
  if (text.startsWith('@@')) return 'hunk'
  if (text.startsWith('+') && !text.startsWith('+++')) return 'add'
  if (text.startsWith('-') && !text.startsWith('---')) return 'del'
  if (text.startsWith('***')) return 'meta'
  return 'ctx'
}

function codeText(line: DiffLine): string {
  if (line.kind === 'add' || line.kind === 'del') return line.text.slice(1)
  if (line.kind === 'ctx') return line.text.startsWith(' ') ? line.text.slice(1) : line.text
  return ''
}

function DiffLineView({ line, tokens }: { line: DiffLine; tokens?: ThemedToken[] }) {
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

function LineDiffCount({ added, deleted }: { added: number; deleted: number }) {
  if (added === 0 && deleted === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums">
      {added > 0 && <span className="text-emerald-300">+{added}</span>}
      {deleted > 0 && <span className="text-red-300">-{deleted}</span>}
    </span>
  )
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
