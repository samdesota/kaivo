export const DEFAULT_WALKTHROUGH_MAX_INPUT_BYTES = 600_000

const ESTIMATED_INSTRUCTION_BYTES = 32 * 1024
const DIGEST_PLACEHOLDER = `sha256:${'0'.repeat(64)}`

export interface WalkthroughInputFileEstimate {
  oldPath: string | null
  path: string
  status: string
}

export function estimateWalkthroughInputBytes(input: {
  patchByteCount: number
  files: WalkthroughInputFileEstimate[]
}): number {
  const manifest = JSON.stringify({
    version: 1,
    digest: DIGEST_PLACEHOLDER,
    files: input.files.map((file, index) => ({
      index,
      oldPath: file.status === 'added' || file.status === 'untracked'
        ? null
        : file.oldPath ?? file.path,
      newPath: file.status === 'deleted' ? null : file.path,
    })),
  })
  return input.patchByteCount + new TextEncoder().encode(manifest).byteLength + ESTIMATED_INSTRUCTION_BYTES
}
