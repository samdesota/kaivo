import { describe, expect, it } from 'vitest'
import {
  parseWalkthroughDirective,
  resolveWalkthroughDirective,
} from '../../../../shared/walkthrough-directive.js'
import { parseCanonicalDiff } from './parser.js'

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts\n',
  'index 1111111..2222222 100644\n',
  '--- a/src/a.ts\n',
  '+++ b/src/a.ts\n',
  '@@ -1 +1 @@\n',
  '-old\n',
  '+new\n',
  '@@ -10 +10 @@\n',
  '-later\n',
  '+latest\n',
].join('')

describe('walkthrough directive contract', () => {
  const diff = parseCanonicalDiff(PATCH)
  const file = diff.files[0]!
  const hunks = file.sections.filter((section) => section.kind === 'hunk')
  const metadata = file.sections.find((section) => section.kind === 'metadata')!
  const base = {
    version: 1 as const,
    diff: diff.digest,
    id: 'request-validation',
    file: { index: 0, oldPath: 'src/a.ts', newPath: 'src/a.ts' },
    collapsed: false,
  }

  it('resolves whole-file, metadata, and exact hunk ranges', () => {
    expect(resolveWalkthroughDirective(diff, base)).toMatchObject({ ok: true, unitIds: file.unitIds })
    const metadataResult = resolveWalkthroughDirective(diff, { ...base, id: 'metadata', sections: [{ kind: 'metadata', index: metadata.index }] })
    expect(metadataResult).toMatchObject({ ok: true, unitIds: [metadata.unitId] })
    const range = { ...base, id: 'range', sections: [{ kind: 'hunk' as const, index: hunks[0]!.index, rows: [1, 1] as [number, number] }] }
    expect(resolveWalkthroughDirective(diff, range)).toMatchObject({ ok: true, unitIds: [hunks[0]!.rows[1]!.unitId] })
  })

  it('normalizes the flat V1 form emitted by early generation prompts', () => {
    const parsed = parseWalkthroughDirective(JSON.stringify({
      version: 1,
      manifestDigest: diff.digest,
      id: 'request-validation-flat',
      fileIndex: 0,
      oldPath: 'src/a.ts',
      newPath: 'src/a.ts',
      collapsed: false,
    }))

    expect(parsed).toMatchObject({
      kind: 'valid',
      directive: {
        diff: diff.digest,
        file: { index: 0, oldPath: 'src/a.ts', newPath: 'src/a.ts' },
      },
    })
    if (parsed.kind !== 'valid') throw new Error('expected a valid directive')
    expect(resolveWalkthroughDirective(diff, parsed.directive)).toMatchObject({ ok: true, unitIds: file.unitIds })
  })

  it.each([
    [{ ...base, diff: `sha256:${'0'.repeat(64)}` }, 'stale diff digest'],
    [{ ...base, file: { ...base.file, newPath: 'other.ts' } }, 'paths do not match'],
    [{ ...base, sections: [{ kind: 'hunk' as const, index: hunks[0]!.index, rows: [0, hunks[0]!.rows.length] as [number, number] }] }, 'outside its hunk'],
    [{ ...base, sections: [{ kind: 'metadata' as const, index: hunks[0]!.index }] }, 'unknown metadata section'],
  ])('rejects stale or cross-section references', (directive, message) => {
    expect(resolveWalkthroughDirective(diff, directive)).toMatchObject({ ok: false, error: expect.stringContaining(message) })
  })

  it('distinguishes unknown versions and requires reasons for promoted noise', () => {
    expect(parseWalkthroughDirective(JSON.stringify({ ...base, version: 2 }))).toMatchObject({ kind: 'unsupported-version', version: 2 })
    expect(resolveWalkthroughDirective(diff, base, { requiresPrimaryReason: true })).toMatchObject({ ok: false, error: expect.stringContaining('primaryReason') })
    expect(resolveWalkthroughDirective(diff, { ...base, primaryReason: 'The dependency change is the feature.' }, { requiresPrimaryReason: true })).toMatchObject({ ok: true })
  })
})
