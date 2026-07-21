export type GitDiffBranchComparison = { kind: 'branch'; originBranch: string | null; includeUncommitted: boolean }

export type GitDiffComparison =
  | GitDiffBranchComparison
  | { kind: 'working-tree'; branch: GitDiffBranchComparison }

export interface GitDiffTransientState {
  comparison: GitDiffComparison
  expandedFiles: Record<string, boolean>
}

const states = new Map<string, GitDiffTransientState>()
const snapshots = new Map<string, unknown>()

export function initialGitDiffState(tabId: string): GitDiffTransientState {
  return states.get(tabId) ?? {
    comparison: { kind: 'branch', originBranch: null, includeUncommitted: true },
    expandedFiles: {},
  }
}

export function retainGitDiffState(tabId: string, state: GitDiffTransientState): void {
  states.set(tabId, state)
}

export function retainedGitDiffSnapshot<T>(tabId: string): T | undefined {
  return snapshots.get(tabId) as T | undefined
}

export function retainGitDiffSnapshot<T>(tabId: string, snapshot: T): void {
  snapshots.set(tabId, snapshot)
}

export function resetGitDiffTransientState(): void {
  states.clear()
  snapshots.clear()
}
