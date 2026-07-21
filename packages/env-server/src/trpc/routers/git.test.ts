import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  discoverGit: vi.fn(),
  originBranches: vi.fn(),
  diff: vi.fn(),
}))

vi.mock('../../envmeta/service.js', () => ({
  isPaired: () => true,
  hashEnvToken: () => 'hash',
  hasEnvTokenHash: () => true,
}))

vi.mock('../../agent/opencode.js', () => ({
  opencodeSupervisor: { verifyAgentShellToken: () => false },
}))

vi.mock('../../config.js', () => ({ config: { CC_KIND: 'local' } }))

vi.mock('../../git/service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../git/service.js')>()
  return { ...original, gitService: mocks }
})

function context(authed = true) {
  return {
    req: { headers: {} } as never,
    res: {} as never,
    envTokenPresent: authed,
    agentShellTokenPresent: false,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('git router', () => {
  it('requires an authenticated paired environment', async () => {
    const { gitRouter } = await import('./git.js')
    const caller = gitRouter.createCaller(context(false))

    await expect(caller.discoverGit({ cwd: '/repo' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(mocks.discoverGit).not.toHaveBeenCalled()
  })

  it('validates strict bounded inputs before invoking the service', async () => {
    const { gitRouter } = await import('./git.js')
    const caller = gitRouter.createCaller(context())

    await expect(caller.discoverGit({ cwd: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.diff({
      cwd: '/repo',
      kind: 'branch',
      originBranch: '',
      includeUncommitted: true,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.diff({
      cwd: '/repo', kind: 'working-tree', includeUncommitted: false,
    } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.discoverGit).not.toHaveBeenCalled()
    expect(mocks.diff).not.toHaveBeenCalled()
  })

  it('returns the structured discovery, branches, and snapshot contracts', async () => {
    const repository = { root: '/repo', gitDir: '/repo/.git', headOid: 'abc', branch: 'feature' }
    const branches = {
      repository,
      branches: [{ name: 'main', ref: 'refs/remotes/origin/main', oid: 'def', isDefault: true }],
      defaultBranch: { name: 'main', ref: 'refs/remotes/origin/main', oid: 'def', isDefault: true },
      defaultSource: 'symbolic-ref' as const,
    }
    const snapshot = {
      repository,
      kind: 'branch' as const,
      baseRef: 'refs/remotes/origin/main',
      mergeBaseOid: '123',
      patch: 'diff --git a/a b/a\n',
      files: [{ oldPath: null, path: 'a', status: 'modified' as const, binary: false, additions: 1, deletions: 0 }],
      additions: 1,
      deletions: 0,
      byteCount: 22,
      truncated: false,
      warnings: [],
    }
    mocks.discoverGit.mockResolvedValue(repository)
    mocks.originBranches.mockResolvedValue(branches)
    mocks.diff.mockResolvedValue(snapshot)
    const { gitRouter } = await import('./git.js')
    const caller = gitRouter.createCaller(context())

    await expect(caller.discoverGit({ cwd: '/repo/subdir' })).resolves.toEqual(repository)
    await expect(caller.originBranches({ cwd: '/repo' })).resolves.toEqual(branches)
    await expect(caller.diff({
      cwd: '/repo', kind: 'branch', originBranch: 'main', includeUncommitted: true,
    })).resolves.toEqual(snapshot)
    expect(mocks.diff).toHaveBeenCalledWith({
      cwd: '/repo', kind: 'branch', originBranch: 'main', includeUncommitted: true,
    })

    await caller.diff({ cwd: '/repo', kind: 'branch', originBranch: 'main', includeUncommitted: false })
    expect(mocks.diff).toHaveBeenLastCalledWith({
      cwd: '/repo', kind: 'branch', originBranch: 'main', includeUncommitted: false,
    })
    await caller.diff({ cwd: '/repo', kind: 'working-tree' })
    expect(mocks.diff).toHaveBeenLastCalledWith({ cwd: '/repo', kind: 'working-tree' })
  })

  it('maps typed service errors to stable tRPC errors', async () => {
    const { GitError } = await import('../../git/service.js')
    mocks.diff.mockRejectedValue(new GitError('no_merge_base', 'histories are unrelated'))
    const { gitRouter } = await import('./git.js')
    const caller = gitRouter.createCaller(context())

    await expect(caller.diff({
      cwd: '/repo', kind: 'branch', originBranch: 'main', includeUncommitted: true,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'histories are unrelated' })
  })
})
