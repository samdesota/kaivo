import { describe, expect, it } from 'vitest'
import { parseCanonicalDiff } from '../../packages/env-server/src/walkthrough/parser'
import { partitionWalkthroughMarkdown } from '../../src/routes/env/tabs/walkthrough-markdown'

const PATCH = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
const canonical = parseCanonicalDiff(PATCH)
const directive = {
  version: 1,
  diff: canonical.digest,
  id: 'behavior',
  file: { index: 0, oldPath: 'a.ts', newPath: 'a.ts' },
  collapsed: false,
}

describe('streaming walkthrough Markdown', () => {
  it('keeps narrative visible and creates a directive only when its fence closes', () => {
    const source = `# Narrative\n\nUseful first.\n\n\`\`\`kaivo-diff\n${JSON.stringify(directive)}\n\`\`\`\n`
    const openingEnd = source.indexOf('\n', source.indexOf('```kaivo-diff')) + 1
    const closingEnd = source.lastIndexOf('```') + 3
    for (let length = 0; length <= source.length; length++) {
      const segments = partitionWalkthroughMarkdown(source.slice(0, length), canonical)
      const combinedMarkdown = segments.filter((segment) => segment.kind === 'markdown').map((segment) => segment.source).join('')
      if (length >= '# Narrative'.length) expect(combinedMarkdown).toContain('# Narrative')
      expect(segments.some((segment) => segment.kind === 'directive')).toBe(length >= closingEnd)
      if (length >= openingEnd && length < closingEnd) {
        expect(segments.some((segment) => segment.kind === 'pending')).toBe(true)
        expect(combinedMarkdown).not.toContain('"version"')
      }
    }
  })

  it('never renders partial malformed JSON and atomically reports it after closure', () => {
    const source = `Before\n\n\`\`\`kaivo-diff\n{"version":1, nope\n\`\`\`\n`
    const openingEnd = source.indexOf('\n', source.indexOf('```kaivo-diff')) + 1
    const closingEnd = source.lastIndexOf('```') + 3
    for (let length = openingEnd; length <= source.length; length++) {
      const segments = partitionWalkthroughMarkdown(source.slice(0, length), canonical)
      expect(segments.some((segment) => segment.kind === 'error')).toBe(length >= closingEnd)
      if (length < closingEnd) expect(segments.some((segment) => segment.kind === 'pending')).toBe(true)
    }
  })

  it('preserves unknown versions as source and rejects duplicate directive IDs', () => {
    const first = `\`\`\`kaivo-diff\n${JSON.stringify(directive)}\n\`\`\`\n`
    const unknown = `\`\`\`kaivo-diff\n${JSON.stringify({ ...directive, version: 9, id: 'future' })}\n\`\`\`\n`
    const segments = partitionWalkthroughMarkdown(first + first + unknown, canonical)
    expect(segments.map((segment) => segment.kind)).toEqual(['directive', 'error', 'unsupported'])
    expect(segments[1]).toMatchObject({ kind: 'error', error: expect.stringContaining('Duplicate') })
    expect(segments[2]).toMatchObject({ kind: 'unsupported', source: expect.stringContaining('"version":9') })
  })
})
