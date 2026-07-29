import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assembleDeterministicWalkthrough, coverageUnitsForWholeFileDirective } from './directives.js'
import { parseCanonicalDiff, sha256Patch, WalkthroughParseError } from './parser.js'

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts\n',
  'index 1111111..2222222 100644\n',
  '--- a/src/a.ts\n',
  '+++ b/src/a.ts\n',
  '@@ -1,3 +1,3 @@\n',
  ' const one = 1\n',
  '-const two = 2\n',
  '+const two = 3\n',
  ' const three = 3\n',
  '@@ -10 +10,2 @@ export function run() {\n',
  '-  return false\n',
  '+  prepare()\n',
  '+  return true\n',
  'diff --git a/old.txt b/new.txt\n',
  'similarity index 100%\n',
  'rename from old.txt\n',
  'rename to new.txt\n',
].join('')

describe('canonical walkthrough diff parser', () => {
  it('parses multi-file and multi-hunk patches losslessly with stable identities', () => {
    const first = parseCanonicalDiff(PATCH)
    const second = parseCanonicalDiff(PATCH)

    expect(first).toEqual(second)
    expect(first.raw).toBe(PATCH)
    expect(first.files.map((file) => file.raw).join('')).toBe(PATCH)
    expect(first.digest).toBe(`sha256:${createHash('sha256').update(Buffer.from(PATCH)).digest('hex')}`)
    expect(first.files).toHaveLength(2)
    expect(first.files[0]).toMatchObject({ index: 0, oldPath: 'src/a.ts', newPath: 'src/a.ts' })
    expect(first.files[1]).toMatchObject({ index: 1, oldPath: 'old.txt', newPath: 'new.txt', status: 'renamed' })
    const hunks = first.files[0]!.sections.filter((section) => section.kind === 'hunk')
    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.rows.map((row) => row.raw)).toEqual([
      ' const one = 1\n', '-const two = 2\n', '+const two = 3\n', ' const three = 3\n',
    ])
    expect(new Set(first.unitIds).size).toBe(first.unitIds.length)
    expect(first.unitIds.every((id) => id.includes(first.digest.slice(7, 23)))).toBe(true)
  })

  it('preserves no-newline rows and UTF-8 patch digest bytes', () => {
    const patch = 'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n--- "a/caf\\303\\251.txt"\n+++ "b/caf\\303\\251.txt"\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n'
    const parsed = parseCanonicalDiff(patch)
    const hunk = parsed.files[0]!.sections.find((section) => section.kind === 'hunk')

    expect(parsed.files[0]).toMatchObject({ oldPath: 'café.txt', newPath: 'café.txt' })
    expect(hunk?.kind === 'hunk' ? hunk.rows.map((row) => row.kind) : []).toEqual([
      'deletion', 'no-newline', 'addition', 'no-newline',
    ])
    expect(parsed.digest).toBe(sha256Patch(patch))
  })

  it('assembles version-1 whole-file directives with exact complete coverage', () => {
    const parsed = parseCanonicalDiff(PATCH)
    const document = assembleDeterministicWalkthrough(parsed)

    expect(document.coveredUnitIds).toEqual(parsed.unitIds)
    expect(document.markdown.match(/```kaivo-diff/g)).toHaveLength(2)
    expect(document.markdown).toContain(`"diff": "${parsed.digest}"`)
    expect(document.markdown).toContain('"oldPath": "old.txt"')
    expect(document.markdown).toContain('"newPath": "new.txt"')
    expect(document.markdown).not.toContain('"sections"')

    const valid = {
      version: 1, diff: parsed.digest, id: 'whole-file', collapsed: false,
      file: { index: 0, oldPath: 'src/a.ts', newPath: 'src/a.ts' },
    }
    expect(coverageUnitsForWholeFileDirective(parsed, valid)).toEqual(parsed.files[0]!.unitIds)
    expect(coverageUnitsForWholeFileDirective(parsed, { ...valid, diff: `sha256:${'0'.repeat(64)}` })).toEqual([])
    expect(coverageUnitsForWholeFileDirective(parsed, { ...valid, file: { ...valid.file, newPath: 'wrong.ts' } })).toEqual([])
  })

  it.each([
    ['', {}, 'empty'],
    [PATCH, { truncated: true }, 'truncated'],
    [PATCH, { maxBytes: 10 }, 'oversized'],
    ['diff --cc src/a.ts\n@@@ -1,1 -1,1 +1,1 @@@\n', {}, 'unsupported'],
    ['diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-old\n+new\n', {}, 'truncated'],
    ['diff --git a/a b/a\nindex 1111111..2222222 100644\n', {}, 'truncated'],
  ] as const)('rejects invalid input before canonical output (%s)', (patch, options, code) => {
    expect(() => parseCanonicalDiff(patch, options)).toThrowError(expect.objectContaining<Partial<WalkthroughParseError>>({ code }))
  })
})
