import type { Root } from 'mdast'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { CanonicalDiff } from '../../../../packages/env-server/src/walkthrough/contracts'
import {
  closedWalkthroughDirectiveFences,
  parseWalkthroughDirective,
  resolveWalkthroughDirective,
  type WalkthroughDirectiveV1,
} from '../../../../shared/walkthrough-directive'

export type WalkthroughMarkdownSegment =
  | { kind: 'markdown'; source: string; start: number }
  | { kind: 'pending'; start: number }
  | { kind: 'directive'; start: number; directive: WalkthroughDirectiveV1; unitIds: string[] }
  | { kind: 'error'; start: number; source: string; error: string }
  | { kind: 'unsupported'; start: number; source: string; version: unknown }

export function partitionWalkthroughMarkdown(markdown: string, canonical: CanonicalDiff): WalkthroughMarkdownSegment[] {
  const segments: WalkthroughMarkdownSegment[] = []
  const ids = new Set<string>()
  let cursor = 0
  for (const fence of closedWalkthroughDirectiveFences(markdown)) {
    pushMarkdown(segments, markdown.slice(cursor, fence.start), cursor)
    const parsed = parseWalkthroughDirective(fence.body)
    if (parsed.kind === 'malformed') {
      segments.push({ kind: 'error', start: fence.start, source: fence.source, error: parsed.error })
    } else if (parsed.kind === 'unsupported-version') {
      segments.push({ kind: 'unsupported', start: fence.start, source: fence.source, version: parsed.version })
    } else if (ids.has(parsed.directive.id)) {
      segments.push({ kind: 'error', start: fence.start, source: fence.source, error: `Duplicate directive id: ${parsed.directive.id}` })
    } else {
      ids.add(parsed.directive.id)
      const resolved = resolveWalkthroughDirective(canonical, parsed.directive)
      if (resolved.ok) segments.push({ kind: 'directive', start: fence.start, directive: parsed.directive, unitIds: resolved.unitIds })
      else segments.push({ kind: 'error', start: fence.start, source: fence.source, error: resolved.error })
    }
    cursor = fence.end
  }

  const pendingStart = pendingDirectiveStart(markdown, cursor)
  if (pendingStart === null) pushMarkdown(segments, markdown.slice(cursor), cursor)
  else {
    pushMarkdown(segments, markdown.slice(cursor, pendingStart), cursor)
    segments.push({ kind: 'pending', start: pendingStart })
  }
  return segments
}

function pushMarkdown(segments: WalkthroughMarkdownSegment[], source: string, start: number): void {
  if (source) segments.push({ kind: 'markdown', source, start })
}

function pendingDirectiveStart(markdown: string, after: number): number | null {
  const tree = unified().use(remarkParse).parse(markdown) as Root
  const candidates: number[] = []
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const value = node as { type?: string; lang?: string | null; position?: { start?: { offset?: number }; end?: { offset?: number } }; children?: unknown[] }
    if (value.type === 'code' && value.lang === 'kaivo-diff') {
      const start = value.position?.start?.offset
      const end = value.position?.end?.offset
      if (typeof start === 'number' && start >= after && end === markdown.length) {
        const source = markdown.slice(start)
        if (/^ {0,3}(?:`{3,}|~{3,})kaivo-diff[\t ]*(?:\r?\n|$)/.test(source)
          && closedWalkthroughDirectiveFences(source).length === 0) candidates.push(start)
      }
    }
    value.children?.forEach(visit)
  }
  visit(tree)
  return candidates.at(-1) ?? null
}
