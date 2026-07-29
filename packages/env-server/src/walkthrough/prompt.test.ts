import { describe, expect, it } from 'vitest'
import { parseCanonicalDiff } from './parser.js'
import { buildGenerationMessages, compactCanonicalManifest, generationInputByteCount } from './prompt.js'

const PATCH = 'diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'

describe('walkthrough generation prompt', () => {
  it('contains only instructions, the complete raw diff, and canonical references', () => {
    const canonical = parseCanonicalDiff(PATCH)
    const messages = buildGenerationMessages(canonical)
    const user = messages.find((message) => message.role === 'user')?.content ?? ''
    const system = messages.find((message) => message.role === 'system')?.content ?? ''

    expect(user).toContain(PATCH)
    expect(user).toContain(compactCanonicalManifest(canonical))
    expect(compactCanonicalManifest(canonical)).not.toContain(canonical.unitIds[0]!)
    expect(compactCanonicalManifest(canonical)).not.toContain('sections')
    expect(generationInputByteCount(messages)).toBeLessThan(Buffer.byteLength(PATCH) + 2_000)
    expect(system).toContain('Order the explanation conceptually')
    expect(system).toContain('Do not request tools')
    expect(system).toContain('one whole-file directive for every manifest file')
    expect(system).toContain('"diff":"sha256:<manifest digest>"')
    expect(system).toContain('"file":{"index":0')
    expect(system).toContain('Do not rename or flatten diff or file fields')
    expect(messages).toHaveLength(2)
  })
})
