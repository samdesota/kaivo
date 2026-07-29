import { describe, expect, it } from 'vitest'
import { branchComparisonPreference, defaultGitDiffComparison, gitDiffInput, resolvedOriginBranch } from '../../src/routes/env/tabs/git-comparison'

describe('git comparison', () => {
  it('resolves branch defaults without changing the persisted preference', () => {
    expect(resolvedOriginBranch(defaultGitDiffComparison, 'main')).toBe('main')
    expect(gitDiffInput('/repo', defaultGitDiffComparison, 'main')).toEqual({
      cwd: '/repo', kind: 'branch', originBranch: 'main', includeUncommitted: true,
    })
    expect(defaultGitDiffComparison).toEqual({ kind: 'branch', originBranch: null, includeUncommitted: true })
  })

  it('retains branch choices while comparing the working tree', () => {
    const branch = { kind: 'branch' as const, originBranch: 'release', includeUncommitted: false }
    const comparison = { kind: 'working-tree' as const, branch }

    expect(branchComparisonPreference(comparison)).toBe(branch)
    expect(gitDiffInput('/repo', comparison, 'main')).toEqual({ cwd: '/repo', kind: 'working-tree' })
  })
})
