import { useEffect, useState } from 'react'
import type { ThemedToken } from 'shiki'
import type { CanonicalDiffFile, CanonicalDiffRow } from '../../../../packages/env-server/src/walkthrough/contracts'
import type { WalkthroughDirectiveV1 } from '../../../../shared/walkthrough-directive'
import { DiffRowView, highlightDiffLines, languageForPath, type DiffPresentationLine } from '../agent/parts/diff-rows'

const largeSelectionRows = 500

export function WalkthroughDiffEmbed({ directive, file, open, onOpenChange }: {
  directive: WalkthroughDirectiveV1
  file: CanonicalDiffFile
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const path = file.newPath ?? file.oldPath ?? `File ${file.index + 1}`
  const lines = selectedLines(file, directive)
  const codeRows = lines.filter((line) => line.kind === 'add' || line.kind === 'del' || line.kind === 'ctx').length
  const large = codeRows > largeSelectionRows
  const [highlightLarge, setHighlightLarge] = useState(false)
  const [tokens, setTokens] = useState<ThemedToken[][]>()
  const highlight = open && (!large || highlightLarge)

  useEffect(() => {
    let cancelled = false
    if (!highlight) {
      setTokens(undefined)
      return
    }
    void highlightDiffLines(path, lines).then((next) => {
      if (!cancelled) setTokens(next ?? undefined)
    }).catch(() => {
      if (!cancelled) setTokens(undefined)
    })
    return () => { cancelled = true }
  }, [directive.id, file.id, highlight, path])

  return (
    <section data-walkthrough-directive={directive.id} className="my-3 min-w-0 max-w-full overflow-hidden rounded border border-neutral-800 bg-neutral-950/70 font-mono text-[11px] leading-5">
      <button
        type="button"
        aria-label={`${open ? 'Collapse' : 'Expand'} ${path} walkthrough diff`}
        onClick={() => onOpenChange(!open)}
        className="flex w-full min-w-0 items-center gap-2 px-2 py-1 text-left hover:bg-neutral-900/70"
      >
        <span className="shrink-0 text-ui-muted">{open ? '▾' : '▸'}</span>
        <span className="min-w-0 flex-1 truncate text-content-default" title={path}>{path}</span>
        {file.binary && <span className="shrink-0 text-[10px] uppercase text-amber-300">Binary</span>}
        {directive.sections && <span className="shrink-0 text-[10px] text-ui-muted">Selected ranges</span>}
      </button>
      {open && (
        <div className="min-w-0 border-t border-neutral-800">
          {large && !highlightLarge && languageForPath(path) !== 'text' && (
            <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-1 text-[10px] text-ui-muted">
              <span>Syntax highlighting deferred for {codeRows.toLocaleString()} rows.</span>
              <button type="button" onClick={() => setHighlightLarge(true)} className="rounded border border-neutral-700 px-2 text-content-default hover:bg-neutral-800">Highlight syntax</button>
            </div>
          )}
          <div className="max-w-full overflow-x-auto py-1 [overflow-wrap:normal]">
            {lines.map((line, index) => <DiffRowView key={`${index}:${line.kind}:${line.text}`} line={line} tokens={tokens?.[index]} />)}
          </div>
        </div>
      )}
    </section>
  )
}

function selectedLines(file: CanonicalDiffFile, directive: WalkthroughDirectiveV1): DiffPresentationLine[] {
  const lines: DiffPresentationLine[] = []
  for (const section of file.sections) {
    if (section.kind === 'metadata') {
      if (!directive.sections || directive.sections.some((selection) => selection.kind === 'metadata' && selection.index === section.index)) {
        lines.push({ kind: 'meta', text: withoutNewline(section.raw) })
      }
      continue
    }
    const ranges = directive.sections?.flatMap((selection) => selection.kind === 'hunk' && selection.index === section.index ? [selection.rows] : [])
    if (directive.sections && (!ranges || ranges.length === 0)) continue
    const rows = directive.sections
      ? section.rows.filter((row) => ranges!.some(([first, last]) => row.index >= first && row.index <= last))
      : section.rows
    if (rows.length === 0) continue
    lines.push({ kind: 'hunk', text: withoutNewline(section.header) })
    lines.push(...rows.map(canonicalRow))
  }
  return lines
}

function canonicalRow(row: CanonicalDiffRow): DiffPresentationLine {
  const kind = row.kind === 'addition' ? 'add'
    : row.kind === 'deletion' ? 'del'
      : row.kind === 'context' ? 'ctx' : 'meta'
  return { kind, text: withoutNewline(row.raw) }
}

function withoutNewline(value: string): string {
  return value.replace(/\r?\n$/, '')
}
