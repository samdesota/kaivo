import type { CanonicalDiff } from './contracts.js'
import type { WalkthroughMessage } from './model-runner.js'

export function compactCanonicalManifest(diff: CanonicalDiff): string {
  return JSON.stringify({
    version: diff.version,
    digest: diff.digest,
    files: diff.files.map((file) => ({
      index: file.index,
      oldPath: file.oldPath,
      newPath: file.newPath,
    })),
  })
}

export function generationInputByteCount(messages: WalkthroughMessage[]): number {
  return messages.reduce((total, message) => total + Buffer.byteLength(message.content), 0)
}

export function buildGenerationMessages(diff: CanonicalDiff): WalkthroughMessage[] {
  return [
    {
      role: 'system',
      content: [
        'Write a concise code-review walkthrough using only the supplied diff and canonical manifest.',
        'Do not request tools, files, repository context, network access, or external facts.',
        'Order the explanation conceptually: lead with behavior and entry points, then follow data and control flow. Do not mechanically follow file order.',
        'Return ordinary Markdown interleaved with closed ```kaivo-diff JSON fences.',
        'For this version, include exactly one whole-file directive for every manifest file and omit sections.',
        'Each directive must use exactly this JSON shape: {"version":1,"diff":"sha256:<manifest digest>","id":"<unique descriptive id>","file":{"index":0,"oldPath":"<exact oldPath or null>","newPath":"<exact newPath or null>"},"collapsed":false}.',
        'Do not rename or flatten diff or file fields. Copy each digest, index, oldPath, and newPath exactly from the manifest.',
        'Never reproduce source code outside directives. Finish only after every file has a directive.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `CANONICAL MANIFEST\n${compactCanonicalManifest(diff)}\n\nRAW UNIFIED DIFF\n${diff.raw}`,
    },
  ]
}
