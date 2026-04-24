import { useMemo } from 'react'

export function DiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => splitLines(diff), [diff])
  if (lines.length === 0) {
    return (
      <pre className="whitespace-pre-wrap p-2 text-[11px] italic text-neutral-500">
        No changes.
      </pre>
    )
  }
  return (
    <pre className="overflow-auto font-mono text-[11px] leading-snug">
      {lines.map((l, i) => (
        <DiffLine key={i} line={l} />
      ))}
    </pre>
  )
}

type LineKind = 'file' | 'hunk' | 'add' | 'del' | 'meta' | 'ctx'

function splitLines(s: string): Array<{ kind: LineKind; text: string }> {
  if (!s) return []
  const out: Array<{ kind: LineKind; text: string }> = []
  for (const raw of s.split('\n')) {
    const text = raw
    let kind: LineKind = 'ctx'
    if (text.startsWith('diff --git ') || text.startsWith('+++ ') || text.startsWith('--- ')) {
      kind = 'file'
    } else if (text.startsWith('@@')) {
      kind = 'hunk'
    } else if (text.startsWith('+') && !text.startsWith('+++')) {
      kind = 'add'
    } else if (text.startsWith('-') && !text.startsWith('---')) {
      kind = 'del'
    } else if (
      text.startsWith('index ') ||
      text.startsWith('new file mode ') ||
      text.startsWith('deleted file mode ') ||
      text.startsWith('similarity ') ||
      text.startsWith('rename ') ||
      text.startsWith('copy ') ||
      text.startsWith('Binary ')
    ) {
      kind = 'meta'
    }
    out.push({ kind, text })
  }
  if (out.length > 0 && out[out.length - 1]!.text === '') out.pop()
  return out
}

function DiffLine({ line }: { line: { kind: LineKind; text: string } }) {
  const base = 'block whitespace-pre px-2'
  switch (line.kind) {
    case 'file':
      return (
        <span className={`${base} mt-2 bg-neutral-900/70 text-neutral-200`}>{line.text || ' '}</span>
      )
    case 'hunk':
      return <span className={`${base} bg-indigo-500/10 text-indigo-300`}>{line.text || ' '}</span>
    case 'add':
      return <span className={`${base} bg-emerald-500/10 text-emerald-300`}>{line.text || ' '}</span>
    case 'del':
      return <span className={`${base} bg-red-500/10 text-red-300`}>{line.text || ' '}</span>
    case 'meta':
      return <span className={`${base} text-neutral-500`}>{line.text || ' '}</span>
    default:
      return <span className={`${base} text-neutral-400`}>{line.text || ' '}</span>
  }
}
