import type { GitDiffFile, GitRepository } from '../git/service.js'
import type { WalkthroughEventType, WalkthroughStatus } from '../db/schema.js'

export type WalkthroughModelVariant = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface WalkthroughModelSelection {
  providerID: string
  modelID: string
  variant: WalkthroughModelVariant | null
}

export interface WalkthroughRunnerIdentity extends WalkthroughModelSelection {
  sessionId: string | null
}

export type GitDiffBranchComparison = {
  kind: 'branch'
  originBranch: string | null
  includeUncommitted: boolean
}

export type GitDiffComparison =
  | GitDiffBranchComparison
  | { kind: 'working-tree'; branch: GitDiffBranchComparison }

export type ResolvedGitDiffComparison =
  | { kind: 'branch'; originBranch: string; includeUncommitted: boolean }
  | { kind: 'working-tree'; branch: GitDiffBranchComparison }

export interface CanonicalDiffRow {
  id: string
  unitId: string
  index: number
  kind: 'context' | 'addition' | 'deletion' | 'no-newline'
  raw: string
  oldLine: number | null
  newLine: number | null
}

export interface CanonicalMetadataSection {
  id: string
  unitId: string
  index: number
  kind: 'metadata'
  raw: string
}

export interface CanonicalHunkSection {
  id: string
  index: number
  kind: 'hunk'
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  rows: CanonicalDiffRow[]
}

export type CanonicalDiffSection = CanonicalMetadataSection | CanonicalHunkSection

export interface CanonicalDiffFile {
  id: string
  index: number
  oldPath: string | null
  newPath: string | null
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied'
  oldMode: string | null
  newMode: string | null
  binary: boolean
  raw: string
  sections: CanonicalDiffSection[]
  unitIds: string[]
}

export interface CanonicalDiff {
  version: 1
  digest: string
  raw: string
  byteCount: number
  files: CanonicalDiffFile[]
  unitIds: string[]
}

export interface WalkthroughEvent {
  id: string
  walkthroughId: string
  sequence: number
  type: WalkthroughEventType
  data: unknown
  createdAt: string
}

export interface WalkthroughSnapshot {
  id: string
  requestKey: string
  status: WalkthroughStatus
  cwd: string
  repository: GitRepository
  comparison: ResolvedGitDiffComparison
  baseRef: string | null
  mergeBaseOid: string | null
  files: GitDiffFile[]
  patch: string
  patchDigest: string
  patchByteCount: number
  canonical: CanonicalDiff
  markdown: string
  coverage: { covered: number; total: number; missing: number }
  warnings: string[]
  error: string | null
  runner: WalkthroughRunnerIdentity | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
  cancelledAt: string | null
  sequence: number
}
