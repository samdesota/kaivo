export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked'

export interface DiffFileMetadata {
  oldPath: string | null
  path: string
  status: DiffFileStatus
  binary: boolean
  additions: number | null
  deletions: number | null
}

export type DiffLineKind = 'hunk' | 'add' | 'del' | 'meta' | 'ctx'

export interface ParsedDiffLine {
  kind: DiffLineKind
  text: string
}

export interface ParsedDiffFile extends DiffFileMetadata {
  id: string
  lines: ParsedDiffLine[]
  incomplete: boolean
}

export function diffFileId(file: Pick<DiffFileMetadata, 'oldPath' | 'path'>, index: number): string {
  return `${index}:${file.oldPath ?? ''}:${file.path}`
}

export function parseUnifiedDiff(
  patch: string,
  metadata?: readonly DiffFileMetadata[],
  truncated = false,
): ParsedDiffFile[] {
  const sections = splitSections(patch)
  const count = Math.max(sections.length, metadata?.length ?? 0)
  const files: ParsedDiffFile[] = []

  for (let index = 0; index < count; index += 1) {
    const section = sections[index] ?? []
    const inferred = inferMetadata(section)
    const authoritative = metadata?.[index]
    const file = authoritative ?? inferred
    if (!file) continue
    const lines = section.slice(1).map((text) => ({ kind: kindForLine(text), text }))
    if (lines.at(-1)?.kind === 'ctx' && lines.at(-1)?.text === '') lines.pop()
    files.push({
      ...file,
      id: diffFileId(file, index),
      lines,
      incomplete: truncated && index === count - 1,
    })
  }
  return files
}

function splitSections(patch: string): string[][] {
  const sections: string[][] = []
  let current: string[] | null = null
  for (const raw of patch.split('\n')) {
    if (raw === '*** Begin Patch' || raw === '*** End Patch') continue
    if (raw.startsWith('diff --git ') || /^\*\*\* (Add|Delete|Update) File: /.test(raw)) {
      current = [raw]
      sections.push(current)
    } else if (current) {
      current.push(raw)
    }
  }
  return sections
}

function inferMetadata(section: readonly string[]): DiffFileMetadata | null {
  const header = section[0]
  if (!header) return null
  const patchFile = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(header)
  let oldPath: string | null = null
  let filePath = patchFile?.[2] ?? 'diff'
  let status: DiffFileStatus = patchFile?.[1] === 'Add' ? 'added' : patchFile?.[1] === 'Delete' ? 'deleted' : 'modified'

  const headerPaths = header.startsWith('diff --git ') ? parseGitHeaderPaths(header.slice('diff --git '.length)) : []
  if (headerPaths.length >= 2) {
    oldPath = stripPrefix(headerPaths[0]!)
    filePath = stripPrefix(headerPaths[1]!)
  }
  for (const line of section) {
    if (line.startsWith('rename from ')) { oldPath = decodeGitPath(line.slice(12)); status = 'renamed' }
    if (line.startsWith('rename to ')) filePath = decodeGitPath(line.slice(10))
    if (line.startsWith('copy from ')) { oldPath = decodeGitPath(line.slice(10)); status = 'copied' }
    if (line.startsWith('copy to ')) filePath = decodeGitPath(line.slice(8))
    if (line.startsWith('new file mode ')) status = 'added'
    if (line.startsWith('deleted file mode ')) status = 'deleted'
    if (line.startsWith('+++ ') && line.slice(4) !== '/dev/null') filePath = stripPrefix(decodeGitPath(line.slice(4)))
  }
  const binary = section.some((line) => line === 'GIT binary patch' || line.startsWith('Binary files '))
  let additions = 0
  let deletions = 0
  for (const line of section) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { oldPath: status === 'renamed' || status === 'copied' ? oldPath : null, path: filePath, status, binary, additions: binary ? null : additions, deletions: binary ? null : deletions }
}

function parseGitHeaderPaths(value: string): string[] {
  const paths: string[] = []
  let index = 0
  while (index < value.length) {
    while (value[index] === ' ') index += 1
    if (index >= value.length) break
    if (value[index] === '"') {
      let token = '"'
      index += 1
      while (index < value.length) {
        const char = value[index++]!
        token += char
        if (char === '\\' && index < value.length) token += value[index++]!
        else if (char === '"') break
      }
      paths.push(decodeGitPath(token))
    } else {
      const end = value.indexOf(' ', index)
      paths.push(value.slice(index, end < 0 ? value.length : end))
      index = end < 0 ? value.length : end
    }
  }
  return paths
}

function decodeGitPath(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"'))) return value
  return value.slice(1, -1).replace(/\\([0-7]{1,3}|[abfnrtv\\"])/g, (_match, escape: string) => {
    if (/^[0-7]/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8))
    const replacements: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' }
    return replacements[escape] ?? escape
  })
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, '')
}

function kindForLine(text: string): DiffLineKind {
  if (text.startsWith('@@')) return 'hunk'
  if (text.startsWith('+') && !text.startsWith('+++')) return 'add'
  if (text.startsWith('-') && !text.startsWith('---')) return 'del'
  if (text.startsWith('index ') || text.startsWith('--- ') || text.startsWith('+++ ') || text.startsWith('new file ') || text.startsWith('deleted file ') || text.startsWith('similarity ') || text.startsWith('rename ') || text.startsWith('copy ')) return 'meta'
  return 'ctx'
}
