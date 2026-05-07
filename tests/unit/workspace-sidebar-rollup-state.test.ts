import { describe, expect, it } from 'vitest'
import { workspaceRollupGlyph, workspaceRollupState } from '../../src/routes/workspace/sidebar-rollup-state'

describe('workspace sidebar rollup state', () => {
  it('prioritizes attention over running over new response over idle', () => {
    expect(workspaceRollupState({ chatCount: 3, pendingAttentionCount: 1, runningCount: 1, newResponseCount: 1 })).toBe('attention')
    expect(workspaceRollupState({ chatCount: 3, pendingAttentionCount: 0, runningCount: 1, newResponseCount: 1 })).toBe('running')
    expect(workspaceRollupState({ chatCount: 3, pendingAttentionCount: 0, runningCount: 0, newResponseCount: 1 })).toBe('new_response')
    expect(workspaceRollupState({ chatCount: 3, pendingAttentionCount: 0, runningCount: 0, newResponseCount: 0 })).toBe('idle')
  })

  it('maps rollup states to sidebar glyphs', () => {
    expect(workspaceRollupGlyph('attention')).toBe('!')
    expect(workspaceRollupGlyph('running')).toBe('*')
    expect(workspaceRollupGlyph('new_response')).toBe('.')
    expect(workspaceRollupGlyph('idle')).toBeNull()
  })
})
