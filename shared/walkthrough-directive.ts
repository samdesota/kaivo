import { z } from 'zod'

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const pathSchema = z.string().max(4096).nullable()

const metadataSelectionSchema = z.object({
  kind: z.literal('metadata'),
  index: z.number().int().nonnegative(),
}).strict()

const hunkSelectionSchema = z.object({
  kind: z.literal('hunk'),
  index: z.number().int().nonnegative(),
  rows: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
}).strict().refine(({ rows }) => rows[0] <= rows[1], {
  message: 'hunk row range must be ordered',
  path: ['rows'],
})

export const walkthroughDirectiveV1Schema = z.object({
  version: z.literal(1),
  diff: digestSchema,
  id: z.string().min(1).max(128),
  file: z.object({
    index: z.number().int().nonnegative(),
    oldPath: pathSchema,
    newPath: pathSchema,
  }).strict(),
  sections: z.array(z.union([metadataSelectionSchema, hunkSelectionSchema])).min(1).max(1024).optional(),
  collapsed: z.boolean(),
  primaryReason: z.string().trim().min(1).max(1000).optional(),
}).strict()

// Early generated walkthroughs used these flat names before the prompt
// described the portable V1 shape explicitly. Normalize that exact form so
// already-persisted documents still resolve against their frozen diff.
const flatWalkthroughDirectiveV1Schema = z.object({
  version: z.literal(1),
  manifestDigest: digestSchema,
  id: z.string().min(1).max(128),
  fileIndex: z.number().int().nonnegative(),
  oldPath: pathSchema,
  newPath: pathSchema,
  sections: z.array(z.union([metadataSelectionSchema, hunkSelectionSchema])).min(1).max(1024).optional(),
  collapsed: z.boolean(),
  primaryReason: z.string().trim().min(1).max(1000).optional(),
}).strict()

export type WalkthroughDirectiveV1 = z.infer<typeof walkthroughDirectiveV1Schema>
export type WalkthroughDirectiveSection = NonNullable<WalkthroughDirectiveV1['sections']>[number]

export type WalkthroughDirectiveParseResult =
  | { kind: 'valid'; directive: WalkthroughDirectiveV1 }
  | { kind: 'unsupported-version'; version: unknown; source: unknown }
  | { kind: 'malformed'; error: string }

export interface DirectiveCanonicalRow {
  index: number
  unitId: string
}

export type DirectiveCanonicalSection =
  | { kind: 'metadata'; index: number; unitId: string }
  | { kind: 'hunk'; index: number; rows: DirectiveCanonicalRow[] }

export interface DirectiveCanonicalFile {
  index: number
  oldPath: string | null
  newPath: string | null
  sections: DirectiveCanonicalSection[]
  unitIds: string[]
}

export interface DirectiveCanonicalDiff {
  digest: string
  files: DirectiveCanonicalFile[]
}

export type WalkthroughDirectiveResolution =
  | { ok: true; directive: WalkthroughDirectiveV1; file: DirectiveCanonicalFile; unitIds: string[] }
  | { ok: false; error: string }

export interface ClosedWalkthroughDirectiveFence {
  start: number
  end: number
  source: string
  body: string
}

export function parseWalkthroughDirective(body: string): WalkthroughDirectiveParseResult {
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (error) {
    return { kind: 'malformed', error: error instanceof Error ? `Invalid directive JSON: ${error.message}` : 'Invalid directive JSON' }
  }
  if (!value || typeof value !== 'object' || !('version' in value)) {
    return { kind: 'malformed', error: 'Directive version is required' }
  }
  if ((value as { version?: unknown }).version !== 1) {
    return { kind: 'unsupported-version', version: (value as { version?: unknown }).version, source: value }
  }
  const parsed = walkthroughDirectiveV1Schema.safeParse(value)
  if (parsed.success) return { kind: 'valid', directive: parsed.data }
  const flat = flatWalkthroughDirectiveV1Schema.safeParse(value)
  if (flat.success) {
    return {
      kind: 'valid',
      directive: {
        version: 1,
        diff: flat.data.manifestDigest,
        id: flat.data.id,
        file: {
          index: flat.data.fileIndex,
          oldPath: flat.data.oldPath,
          newPath: flat.data.newPath,
        },
        sections: flat.data.sections,
        collapsed: flat.data.collapsed,
        primaryReason: flat.data.primaryReason,
      },
    }
  }
  return { kind: 'malformed', error: parsed.error.issues[0]?.message ?? 'Invalid directive' }
}

export function resolveWalkthroughDirective(
  diff: DirectiveCanonicalDiff,
  directive: WalkthroughDirectiveV1,
  options: { requiresPrimaryReason?: boolean } = {},
): WalkthroughDirectiveResolution {
  if (directive.diff !== diff.digest) return { ok: false, error: 'Directive references a stale diff digest' }
  const file = diff.files[directive.file.index]
  if (!file || file.index !== directive.file.index) return { ok: false, error: 'Directive references an unknown file' }
  if (directive.file.oldPath !== file.oldPath || directive.file.newPath !== file.newPath) {
    return { ok: false, error: 'Directive paths do not match the frozen diff' }
  }
  if (options.requiresPrimaryReason && !directive.primaryReason) {
    return { ok: false, error: 'Promoted dependency or generated changes require primaryReason' }
  }
  if (!directive.sections) return { ok: true, directive, file, unitIds: [...file.unitIds] }

  const units = new Set<string>()
  for (const selection of directive.sections) {
    const section = file.sections.find((candidate) => candidate.index === selection.index)
    if (!section || section.kind !== selection.kind) {
      return { ok: false, error: `Directive references an unknown ${selection.kind} section` }
    }
    if (selection.kind === 'metadata') {
      if (section.kind !== 'metadata') return { ok: false, error: 'Directive metadata selection does not reference metadata' }
      units.add(section.unitId)
      continue
    }
    if (section.kind !== 'hunk') return { ok: false, error: 'Directive hunk selection does not reference a hunk' }
    const [first, last] = selection.rows
    const rows = section.rows.filter((row) => row.index >= first && row.index <= last)
    if (rows.length !== last - first + 1 || rows[0]?.index !== first || rows.at(-1)?.index !== last) {
      return { ok: false, error: 'Directive row range is outside its hunk' }
    }
    for (const row of rows) units.add(row.unitId)
  }
  if (units.size === 0) return { ok: false, error: 'Directive selects no canonical diff units' }
  return { ok: true, directive, file, unitIds: [...units] }
}

export function closedWalkthroughDirectiveFences(markdown: string): ClosedWalkthroughDirectiveFence[] {
  const fences: ClosedWalkthroughDirectiveFence[] = []
  const opening = /^( {0,3})(`{3,}|~{3,})kaivo-diff[\t ]*(?:\r?\n|$)/gm
  let match: RegExpExecArray | null
  while ((match = opening.exec(markdown))) {
    const marker = match[2]!
    const bodyStart = opening.lastIndex
    const closing = new RegExp(`^ {0,3}${escapeRegExp(marker[0]!)}{${marker.length},}[\\t ]*(?:\\r?\\n|$)`, 'gm')
    closing.lastIndex = bodyStart
    const endMatch = closing.exec(markdown)
    if (!endMatch) continue
    const bodyEnd = endMatch.index
    const end = closing.lastIndex
    fences.push({
      start: match.index,
      end,
      source: markdown.slice(match.index, end),
      body: markdown.slice(bodyStart, bodyEnd).replace(/\r?\n$/, ''),
    })
    opening.lastIndex = end
  }
  return fences
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
