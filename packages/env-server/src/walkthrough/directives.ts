import type { CanonicalDiff } from './contracts.js'
import {
  parseWalkthroughDirective,
  resolveWalkthroughDirective,
  type WalkthroughDirectiveV1,
} from '../../../../shared/walkthrough-directive.js'

export interface DeterministicWalkthroughDocument {
  markdown: string
  coveredUnitIds: string[]
}

export type WholeFileDirectiveV1 = WalkthroughDirectiveV1 & { sections?: undefined }

export function coverageUnitsForWholeFileDirective(diff: CanonicalDiff, value: unknown): string[] {
  const parsed = parseWalkthroughDirective(JSON.stringify(value))
  if (parsed.kind !== 'valid' || parsed.directive.sections) return []
  const resolved = resolveWalkthroughDirective(diff, parsed.directive)
  return resolved.ok ? resolved.unitIds : []
}

function title(index: number, oldPath: string | null, newPath: string | null): string {
  const path = newPath ?? oldPath ?? `File ${index + 1}`
  if (oldPath && newPath && oldPath !== newPath) return `${oldPath} -> ${newPath}`
  return path
}

export function assembleDeterministicWalkthrough(diff: CanonicalDiff): DeterministicWalkthroughDocument {
  const chunks = ['# Code Walkthrough\n\n']
  const coveredUnitIds: string[] = []
  for (const file of diff.files) {
    const directive: WholeFileDirectiveV1 = {
      version: 1,
      diff: diff.digest,
      id: `file-${file.index + 1}`,
      file: { index: file.index, oldPath: file.oldPath, newPath: file.newPath },
      collapsed: false,
    }
    const selected = coverageUnitsForWholeFileDirective(diff, directive)
    if (selected.length !== file.unitIds.length) throw new Error(`invalid deterministic directive for file ${file.index}`)
    coveredUnitIds.push(...selected)
    chunks.push(`## ${title(file.index, file.oldPath, file.newPath)}\n\n`)
    chunks.push(`\`\`\`kaivo-diff\n${JSON.stringify(directive, null, 2)}\n\`\`\`\n\n`)
  }
  return { markdown: chunks.join(''), coveredUnitIds }
}
