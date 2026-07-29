import type { BundledLanguage, ThemedToken } from 'shiki'

export interface DiffPresentationLine {
  kind: 'hunk' | 'meta' | 'add' | 'del' | 'ctx'
  text: string
}

export function codeText(line: DiffPresentationLine): string {
  if (line.kind === 'add' || line.kind === 'del') return line.text.slice(1)
  if (line.kind === 'ctx') return line.text.startsWith(' ') ? line.text.slice(1) : line.text
  return ''
}

export function DiffRowView({ line, tokens }: { line: DiffPresentationLine; tokens?: ThemedToken[] }) {
  if (line.kind === 'hunk') return <div className="px-3 py-0.5 text-[10px] text-sky-300/80">{line.text}</div>
  if (line.kind === 'meta') return <div className="px-3 py-0.5 text-[10px] text-ui-muted">{line.text}</div>

  const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
  const text = codeText(line)
  const rowClass = line.kind === 'add'
    ? 'bg-emerald-500/[0.08]'
    : line.kind === 'del' ? 'bg-red-500/[0.08]' : 'hover:bg-white/[0.025]'
  const gutterClass = line.kind === 'add'
    ? 'text-emerald-300/80'
    : line.kind === 'del' ? 'text-red-300/80' : 'text-neutral-700'

  return (
    <div className={`grid grid-cols-[2rem_minmax(0,1fr)] ${rowClass}`}>
      <span className={`select-none text-center ${gutterClass}`}>{marker}</span>
      <span className="whitespace-pre pr-3 text-content-default">
        {tokens && tokens.length > 0 ? <TokenSpans tokens={tokens} /> : text || ' '}
      </span>
    </div>
  )
}

export async function highlightDiffLines(path: string, lines: readonly DiffPresentationLine[]): Promise<ThemedToken[][] | null> {
  const language = languageForPath(path)
  if (language === 'text' || lines.length === 0) return null
  const { codeToTokens } = await import('shiki')
  const result = await codeToTokens(lines.map((line) => codeText(line)).join('\n'), {
    lang: language,
    theme: 'github-dark-default',
    tokenizeMaxLineLength: 500,
  })
  return result.tokens
}

function TokenSpans({ tokens }: { tokens: ThemedToken[] }) {
  return <>{tokens.map((token, index) => <span key={`${index}:${token.offset}`} style={token.color ? { color: token.color } : undefined}>{token.content}</span>)}</>
}

export function languageForPath(path: string): BundledLanguage | 'text' {
  const filename = path.split('/').pop()?.toLowerCase() ?? ''
  if (filename === 'dockerfile') return 'docker'
  if (filename === 'makefile') return 'make'
  const ext = filename.split('.').pop() ?? ''
  const map: Record<string, BundledLanguage> = {
    astro: 'astro', c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css', go: 'go', h: 'c',
    hbs: 'handlebars', html: 'html', java: 'java', js: 'javascript', json: 'json', jsonc: 'jsonc',
    jsx: 'jsx', kt: 'kotlin', less: 'less', lua: 'lua', md: 'markdown', mdx: 'mdx', php: 'php',
    py: 'python', rb: 'ruby', rs: 'rust', sass: 'sass', scss: 'scss', sh: 'shellscript', sql: 'sql',
    svelte: 'svelte', swift: 'swift', toml: 'toml', ts: 'typescript', tsx: 'tsx', vue: 'vue',
    xml: 'xml', yaml: 'yaml', yml: 'yaml', zig: 'zig',
  }
  return map[ext] ?? 'text'
}
