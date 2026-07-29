import { createHash } from 'node:crypto'
import type {
  CanonicalDiff,
  CanonicalDiffFile,
  CanonicalDiffRow,
  CanonicalDiffSection,
} from './contracts.js'

export const DEFAULT_MAX_WALKTHROUGH_PATCH_BYTES = 5 * 1024 * 1024

export type WalkthroughParseErrorCode = 'empty' | 'truncated' | 'oversized' | 'unsupported' | 'malformed'

export class WalkthroughParseError extends Error {
  constructor(public readonly code: WalkthroughParseErrorCode, message: string) {
    super(message)
    this.name = 'WalkthroughParseError'
  }
}

export function sha256Patch(patch: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(patch, 'utf8')).digest('hex')}`
}

function exactLines(value: string): string[] {
  const lines: string[] = []
  let start = 0
  while (start < value.length) {
    const newline = value.indexOf('\n', start)
    if (newline < 0) {
      lines.push(value.slice(start))
      break
    }
    lines.push(value.slice(start, newline + 1))
    start = newline + 1
  }
  return lines
}

function withoutEol(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1).replace(/\r$/, '') : line
}

function decodeGitQuoted(value: string): string {
  if (!value.startsWith('"')) return value
  if (!value.endsWith('"')) throw new WalkthroughParseError('malformed', 'unterminated quoted Git path')
  const bytes: number[] = []
  for (let index = 1; index < value.length - 1; index++) {
    const char = value[index]!
    if (char !== '\\') {
      bytes.push(...Buffer.from(char))
      continue
    }
    const escaped = value[++index]
    if (escaped === undefined) throw new WalkthroughParseError('malformed', 'unterminated Git path escape')
    const simple: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }
    if (escaped in simple) bytes.push(simple[escaped]!)
    else if (/[0-7]/.test(escaped)) {
      let octal = escaped
      while (octal.length < 3 && /[0-7]/.test(value[index + 1] ?? '')) octal += value[++index]
      bytes.push(Number.parseInt(octal, 8))
    } else {
      throw new WalkthroughParseError('malformed', `unsupported Git path escape: \\${escaped}`)
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

function pathToken(line: string, offset: number): { value: string; end: number } {
  if (line[offset] !== '"') {
    const end = line.indexOf(' ', offset)
    return { value: line.slice(offset, end < 0 ? line.length : end), end: end < 0 ? line.length : end }
  }
  let escaped = false
  for (let index = offset + 1; index < line.length; index++) {
    if (!escaped && line[index] === '"') return { value: line.slice(offset, index + 1), end: index + 1 }
    if (!escaped && line[index] === '\\') escaped = true
    else escaped = false
  }
  throw new WalkthroughParseError('malformed', 'unterminated quoted Git path')
}

function diffPaths(header: string): [string | null, string | null] {
  const line = withoutEol(header)
  const first = pathToken(line, 'diff --git '.length)
  let offset = first.end
  while (line[offset] === ' ') offset++
  const second = pathToken(line, offset)
  if (!first.value || !second.value || second.end !== line.length) {
    throw new WalkthroughParseError('malformed', 'malformed diff --git header')
  }
  const oldPath = decodeGitQuoted(first.value)
  const newPath = decodeGitQuoted(second.value)
  return [oldPath === '/dev/null' ? null : oldPath.replace(/^a\//, ''), newPath === '/dev/null' ? null : newPath.replace(/^b\//, '')]
}

function markerPath(line: string, marker: '--- ' | '+++ '): string | null {
  const value = withoutEol(line).slice(marker.length).split('\t', 1)[0]!
  if (value === '/dev/null') return null
  const decoded = decodeGitQuoted(value)
  return decoded.replace(marker === '--- ' ? /^a\// : /^b\//, '')
}

function stableId(digest: string, file: number, section?: number, row?: number): string {
  const prefix = digest.slice('sha256:'.length)
  return [prefix, `f${file}`, section === undefined ? null : `s${section}`, row === undefined ? null : `r${row}`]
    .filter((part): part is string => part !== null).join(':')
}

function parseFile(rawLines: string[], fileIndex: number, digest: string): CanonicalDiffFile {
  let [oldPath, newPath] = diffPaths(rawLines[0]!)
  let oldMode: string | null = null
  let newMode: string | null = null
  let status: CanonicalDiffFile['status'] = 'modified'
  let binary = false
  let hasHunk = false
  let standaloneMetadata = false
  let sawOldMarker = false
  let sawNewMarker = false
  let sawOldMode = false
  let sawNewMode = false
  let sawRenameFrom = false
  let sawRenameTo = false
  let sawCopyFrom = false
  let sawCopyTo = false
  let sawGitBinaryPatch = false
  let sawBinaryPayload = false
  const sections: CanonicalDiffSection[] = []
  const unitIds: string[] = []
  let index = 0
  while (index < rawLines.length) {
    const line = rawLines[index]!
    const plain = withoutEol(line)
    if (plain.startsWith('@@@')) throw new WalkthroughParseError('unsupported', 'combined diffs are not supported')
    if (!plain.startsWith('@@ ')) {
      if (plain.startsWith('--- ')) { oldPath = markerPath(line, '--- '); sawOldMarker = true }
      if (plain.startsWith('+++ ')) { newPath = markerPath(line, '+++ '); sawNewMarker = true }
      if (plain.startsWith('old mode ')) { oldMode = plain.slice('old mode '.length); sawOldMode = true }
      if (plain.startsWith('new mode ')) { newMode = plain.slice('new mode '.length); sawNewMode = true }
      if (plain.startsWith('new file mode ')) { status = 'added'; newMode = plain.slice('new file mode '.length); standaloneMetadata = true }
      if (plain.startsWith('deleted file mode ')) { status = 'deleted'; oldMode = plain.slice('deleted file mode '.length); standaloneMetadata = true }
      if (plain.startsWith('rename from ')) { status = 'renamed'; sawRenameFrom = true }
      if (plain.startsWith('rename to ')) { status = 'renamed'; sawRenameTo = true }
      if (plain.startsWith('copy from ')) { status = 'copied'; sawCopyFrom = true }
      if (plain.startsWith('copy to ')) { status = 'copied'; sawCopyTo = true }
      if (plain === 'GIT binary patch') { binary = true; sawGitBinaryPatch = true }
      if (/^(literal|delta) \d+$/.test(plain)) sawBinaryPayload = true
      if (plain.startsWith('Binary files ')) { binary = true; standaloneMetadata = true }
      const sectionIndex = sections.length
      const unitId = stableId(digest, fileIndex, sectionIndex)
      sections.push({ id: unitId, unitId, index: sectionIndex, kind: 'metadata', raw: line })
      unitIds.push(unitId)
      index++
      continue
    }

    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(plain)
    if (!match) throw new WalkthroughParseError('malformed', `malformed hunk header: ${plain}`)
    const oldStart = Number(match[1])
    const oldCount = match[2] === undefined ? 1 : Number(match[2])
    const newStart = Number(match[3])
    const newCount = match[4] === undefined ? 1 : Number(match[4])
    const sectionIndex = sections.length
    hasHunk = true
    const rows: CanonicalDiffRow[] = []
    let oldLine = oldStart
    let newLine = newStart
    let seenOld = 0
    let seenNew = 0
    index++
    while (index < rawLines.length && !withoutEol(rawLines[index]!).startsWith('@@ ') && !rawLines[index]!.startsWith('diff --git ')) {
      const rowRaw = rawLines[index]!
      const prefix = rowRaw[0]
      let kind: CanonicalDiffRow['kind']
      let rowOld: number | null = null
      let rowNew: number | null = null
      if (prefix === ' ') {
        kind = 'context'; rowOld = oldLine++; rowNew = newLine++; seenOld++; seenNew++
      } else if (prefix === '+') {
        kind = 'addition'; rowNew = newLine++; seenNew++
      } else if (prefix === '-') {
        kind = 'deletion'; rowOld = oldLine++; seenOld++
      } else if (withoutEol(rowRaw) === '\\ No newline at end of file') {
        kind = 'no-newline'
      } else {
        throw new WalkthroughParseError('truncated', `hunk ended before its declared rows: ${plain}`)
      }
      const rowIndex = rows.length
      const unitId = stableId(digest, fileIndex, sectionIndex, rowIndex)
      rows.push({ id: unitId, unitId, index: rowIndex, kind, raw: rowRaw, oldLine: rowOld, newLine: rowNew })
      unitIds.push(unitId)
      index++
    }
    if (seenOld !== oldCount || seenNew !== newCount) {
      throw new WalkthroughParseError('truncated', `hunk row count mismatch: expected -${oldCount}/+${newCount}, received -${seenOld}/+${seenNew}`)
    }
    sections.push({ id: stableId(digest, fileIndex, sectionIndex), index: sectionIndex, kind: 'hunk', header: line, oldStart, oldCount, newStart, newCount, rows })
  }
  if (sawOldMarker !== sawNewMarker) throw new WalkthroughParseError('truncated', 'diff contains an incomplete file marker pair')
  if (sawOldMode !== sawNewMode || sawRenameFrom !== sawRenameTo || sawCopyFrom !== sawCopyTo || (sawGitBinaryPatch && !sawBinaryPayload)) {
    throw new WalkthroughParseError('truncated', 'diff contains incomplete file metadata')
  }
  const completeMetadata = standaloneMetadata || (sawOldMode && sawNewMode) || (sawRenameFrom && sawRenameTo)
    || (sawCopyFrom && sawCopyTo) || (sawGitBinaryPatch && sawBinaryPayload)
  if (!hasHunk && !completeMetadata) throw new WalkthroughParseError('truncated', 'diff file contains no complete hunk or metadata change')
  if (status === 'modified') {
    if (oldPath === null) status = 'added'
    else if (newPath === null) status = 'deleted'
  }
  return {
    id: stableId(digest, fileIndex), index: fileIndex, oldPath, newPath, status, oldMode, newMode, binary,
    raw: rawLines.join(''), sections, unitIds,
  }
}

export function parseCanonicalDiff(patch: string, options: { maxBytes?: number; truncated?: boolean } = {}): CanonicalDiff {
  const byteCount = Buffer.byteLength(patch, 'utf8')
  if (options.truncated) throw new WalkthroughParseError('truncated', 'truncated patches cannot start a walkthrough')
  if (byteCount === 0 || patch.trim().length === 0) throw new WalkthroughParseError('empty', 'empty diffs cannot start a walkthrough')
  if (byteCount > (options.maxBytes ?? DEFAULT_MAX_WALKTHROUGH_PATCH_BYTES)) {
    throw new WalkthroughParseError('oversized', `patch exceeds the ${(options.maxBytes ?? DEFAULT_MAX_WALKTHROUGH_PATCH_BYTES)} byte limit`)
  }
  if (/^(diff --cc |diff --combined |@@@)/m.test(patch)) {
    throw new WalkthroughParseError('unsupported', 'combined diffs are not supported')
  }
  const lines = exactLines(patch)
  const starts = lines.map((line, index) => line.startsWith('diff --git ') ? index : -1).filter((index) => index >= 0)
  if (starts.length === 0 || starts[0] !== 0) throw new WalkthroughParseError('unsupported', 'only ordinary Git unified diffs are supported')
  const digest = sha256Patch(patch)
  const files = starts.map((start, fileIndex) => parseFile(lines.slice(start, starts[fileIndex + 1] ?? lines.length), fileIndex, digest))
  const unitIds = files.flatMap((file) => file.unitIds)
  if (unitIds.length === 0) throw new WalkthroughParseError('empty', 'diff contains no coverable records')
  return { version: 1, digest, raw: patch, byteCount, files, unitIds }
}
