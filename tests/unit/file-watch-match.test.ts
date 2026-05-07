import { describe, expect, it } from 'vitest'
import { shouldRefreshFileForFsEvent } from '../../src/routes/env/file-watch-match'

describe('shouldRefreshFileForFsEvent', () => {
  it('matches workspace-relative file change events', () => {
    expect(shouldRefreshFileForFsEvent({ type: 'change', path: '/src/a.ts' }, '/src/a.ts')).toBe(true)
    expect(shouldRefreshFileForFsEvent({ type: 'change', path: 'src/a.ts' }, '/src/a.ts')).toBe(true)
  })

  it('matches absolute pane paths by workspace-relative event suffix', () => {
    expect(
      shouldRefreshFileForFsEvent(
        { type: 'change', path: '/src/a.ts' },
        '/Users/sam/d/repos/cloud-code-tools/src/a.ts',
        true,
      ),
    ).toBe(true)
  })

  it('ignores unrelated files and directory events', () => {
    expect(shouldRefreshFileForFsEvent({ type: 'change', path: '/src/b.ts' }, '/src/a.ts')).toBe(false)
    expect(shouldRefreshFileForFsEvent({ type: 'addDir', path: '/src' }, '/src/a.ts')).toBe(false)
    expect(shouldRefreshFileForFsEvent({ type: 'unlinkDir', path: '/src' }, '/src/a.ts')).toBe(false)
  })
})
