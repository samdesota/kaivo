import { defaultGitDiffComparison, type GitDiffComparison } from './git-comparison'

export type { GitDiffComparison } from './git-comparison'

export interface GitDiffTransientState {
  comparison: GitDiffComparison
  expandedFiles: Record<string, boolean>
}

const states = new Map<string, GitDiffTransientState>()
const snapshots = new Map<string, unknown>()

export function initialGitDiffState(tabId: string): GitDiffTransientState {
  return states.get(tabId) ?? {
    comparison: defaultGitDiffComparison,
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
