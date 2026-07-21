import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitError, GitService } from './service.js'

const exec = promisify(execFile)
let roots: string[] = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec('git', args, { cwd, encoding: 'utf8' })
  return result.stdout.trim()
}

async function tempDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-service-'))
  roots.push(root)
  return root
}

async function initRepo(): Promise<string> {
  const root = await tempDir()
  await git(root, 'init', '--initial-branch=main')
  await git(root, 'config', 'user.email', 'test@example.com')
  await git(root, 'config', 'user.name', 'Test User')
  return root
}

async function write(root: string, name: string, contents: string | Buffer): Promise<void> {
  const target = path.join(root, name)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, contents)
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, 'add', '-A')
  await git(root, 'commit', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

beforeEach(() => {
  roots = []
})

afterEach(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('GitService', () => {
  it('discovers canonical repository and git roots from a nested symlink', async () => {
    const root = await initRepo()
    await write(root, 'src/file.txt', 'base\n')
    const headOid = await commitAll(root, 'base')
    const links = await tempDir()
    await fs.symlink(path.join(root, 'src'), path.join(links, 'linked-src'))

    const repository = await new GitService().discoverGit(path.join(links, 'linked-src'))

    expect(repository).toEqual({
      root: await fs.realpath(root),
      gitDir: await fs.realpath(path.join(root, '.git')),
      headOid,
      branch: 'main',
    })
    await expect(new GitService().discoverGit(links)).resolves.toBeNull()
  })

  it('enumerates only local origin refs and prefers symbolic origin/HEAD', async () => {
    const root = await initRepo()
    await write(root, 'file.txt', 'base\n')
    const oid = await commitAll(root, 'base')
    await git(root, 'update-ref', 'refs/remotes/origin/main', oid)
    await git(root, 'update-ref', 'refs/remotes/origin/trunk', oid)
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')

    const result = await new GitService().originBranches(root)

    expect(result.defaultSource).toBe('symbolic-ref')
    expect(result.defaultBranch?.name).toBe('trunk')
    expect(result.branches.map((branch) => branch.name)).toEqual(['main', 'trunk'])
    expect(result.branches.find((branch) => branch.name === 'trunk')?.isDefault).toBe(true)
  })

  it('falls back from origin/main to origin/master and then no default', async () => {
    const root = await initRepo()
    await write(root, 'file.txt', 'base\n')
    const oid = await commitAll(root, 'base')
    const service = new GitService()
    await git(root, 'update-ref', 'refs/remotes/origin/master', oid)
    expect((await service.originBranches(root)).defaultBranch?.name).toBe('master')
    await git(root, 'update-ref', 'refs/remotes/origin/main', oid)
    expect((await service.originBranches(root)).defaultBranch?.name).toBe('main')
    await git(root, 'update-ref', '-d', 'refs/remotes/origin/main')
    await git(root, 'update-ref', '-d', 'refs/remotes/origin/master')
    expect(await service.originBranches(root)).toMatchObject({ defaultBranch: null, defaultSource: 'none' })
  })

  it('diffs from merge-base through committed, staged, unstaged, and untracked state', async () => {
    const root = await initRepo()
    await write(root, 'shared.txt', 'base\n')
    await write(root, 'unstaged.txt', 'base\n')
    const baseOid = await commitAll(root, 'base')
    await git(root, 'checkout', '-b', 'feature')
    await write(root, 'feature.txt', 'committed\n')
    await commitAll(root, 'feature work')

    await git(root, 'checkout', 'main')
    await write(root, 'base-only.txt', 'must not appear\n')
    const originOid = await commitAll(root, 'origin advanced')
    await git(root, 'update-ref', 'refs/remotes/origin/main', originOid)
    await git(root, 'checkout', 'feature')
    await write(root, 'staged.txt', 'staged\n')
    await git(root, 'add', 'staged.txt')
    await write(root, 'unstaged.txt', 'changed\n')
    await write(root, 'untracked.txt', 'new one\nnew two\n')

    const result = await new GitService().diff({
      cwd: path.join(root, 'src', '..'),
      kind: 'branch',
      originBranch: 'main',
      includeUncommitted: true,
    })

    expect(result.mergeBaseOid).toBe(baseOid)
    expect(result.baseRef).toBe('refs/remotes/origin/main')
    expect(result.files.map((file) => [file.path, file.status])).toEqual([
      ['feature.txt', 'added'],
      ['staged.txt', 'added'],
      ['unstaged.txt', 'modified'],
      ['untracked.txt', 'untracked'],
    ])
    expect(result.patch).toContain('committed')
    expect(result.patch).toContain('staged')
    expect(result.patch).toContain('changed')
    expect(result.patch).toContain('new two')
    expect(result.patch).not.toContain('must not appear')
    expect(result).toMatchObject({ additions: 5, deletions: 1, truncated: false, warnings: [] })
  })

  it('supports committed-only, alternate-base, and working-tree comparisons', async () => {
    const root = await initRepo()
    await write(root, 'shared.txt', 'base\n')
    const baseOid = await commitAll(root, 'base')
    await git(root, 'update-ref', 'refs/remotes/origin/main', baseOid)
    await git(root, 'checkout', '-b', 'feature')
    await write(root, 'committed.txt', 'feature\n')
    const featureOid = await commitAll(root, 'feature')
    await git(root, 'update-ref', 'refs/remotes/origin/release', featureOid)
    await write(root, 'staged.txt', 'staged\n')
    await git(root, 'add', 'staged.txt')
    await write(root, 'shared.txt', 'unstaged\n')
    await write(root, 'untracked.txt', 'untracked\n')
    const service = new GitService()

    const committedOnly = await service.diff({ cwd: root, kind: 'branch', originBranch: 'main', includeUncommitted: false })
    expect(committedOnly.files.map((file) => file.path)).toEqual(['committed.txt'])

    const alternateBase = await service.diff({ cwd: root, kind: 'branch', originBranch: 'release', includeUncommitted: false })
    expect(alternateBase.files).toEqual([])

    const workingTree = await service.diff({ cwd: root, kind: 'working-tree' })
    expect(workingTree.files.map((file) => file.path)).toEqual(['shared.txt', 'staged.txt', 'untracked.txt'])
    expect(workingTree.patch).not.toContain('committed.txt')
    expect(workingTree).toMatchObject({ kind: 'working-tree', baseRef: null, mergeBaseOid: null })
  })

  it('rejects missing origin refs and unrelated histories', async () => {
    const root = await initRepo()
    await write(root, 'base.txt', 'base\n')
    await commitAll(root, 'base')
    const service = new GitService()
    await expect(service.diff({ cwd: root, kind: 'branch', originBranch: 'missing', includeUncommitted: true }))
      .rejects.toMatchObject({ code: 'origin_branch_not_found' })

    const unrelated = await git(root, 'commit-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', '-m', 'unrelated')
    await git(root, 'update-ref', 'refs/remotes/origin/unrelated', unrelated)
    await expect(service.diff({ cwd: root, kind: 'branch', originBranch: 'unrelated', includeUncommitted: true }))
      .rejects.toMatchObject({ code: 'no_merge_base' })
  })

  it('reports detached and unborn repositories without mutating them', async () => {
    const root = await initRepo()
    await write(root, 'file.txt', 'base\n')
    const oid = await commitAll(root, 'base')
    await git(root, 'checkout', '--detach', oid)
    expect(await new GitService().discoverGit(root)).toMatchObject({ branch: null, headOid: oid })

    const unborn = await initRepo()
    await write(unborn, 'new.txt', 'new\n')
    expect(await new GitService().discoverGit(unborn)).toMatchObject({ branch: 'main', headOid: null })
    const unbornDiff = await new GitService().diff({
      cwd: unborn,
      kind: 'working-tree',
    })
    expect(unbornDiff.files).toEqual([
      expect.objectContaining({ path: 'new.txt', status: 'untracked', additions: 1 }),
    ])
    expect(unbornDiff.patch).toContain('+new')
    await expect(git(unborn, 'status', '--porcelain')).resolves.toBe('?? new.txt')
  })

  it('retains rename and binary metadata and unusual untracked paths', async () => {
    const root = await initRepo()
    await write(root, 'old name.txt', 'same contents\n')
    await write(root, 'tab\tname.txt', 'before\n')
    await write(root, 'line\nname.txt', 'before\n')
    const oid = await commitAll(root, 'base')
    await git(root, 'update-ref', 'refs/remotes/origin/main', oid)
    await fs.rename(path.join(root, 'old name.txt'), path.join(root, 'new name.txt'))
    await git(root, 'add', '-A')
    await write(root, 'tab\tname.txt', 'after\n')
    await write(root, 'line\nname.txt', 'after\n')
    await write(root, 'binary.dat', Buffer.from([0, 1, 2, 3]))
    await write(root, '-odd name.txt', 'odd\n')

    const result = await new GitService().diff({ cwd: root, kind: 'branch', originBranch: 'main', includeUncommitted: true })

    expect(result.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ oldPath: 'old name.txt', path: 'new name.txt', status: 'renamed' }),
      expect.objectContaining({ path: 'binary.dat', status: 'untracked', binary: true, additions: null }),
      expect.objectContaining({ path: '-odd name.txt', status: 'untracked', additions: 1 }),
      expect.objectContaining({ path: 'tab\tname.txt', status: 'modified', additions: 1, deletions: 1 }),
      expect.objectContaining({ path: 'line\nname.txt', status: 'modified', additions: 1, deletions: 1 }),
    ]))
    expect(result.patch).toContain('GIT binary patch')
  })

  it('bounds the combined patch while retaining independently computed metadata', async () => {
    const root = await initRepo()
    await write(root, 'base.txt', 'base\n')
    const oid = await commitAll(root, 'base')
    await git(root, 'update-ref', 'refs/remotes/origin/main', oid)
    await write(root, 'large.txt', `${'abcdefghij\n'.repeat(100)}`)

    const result = await new GitService({ maxPatchBytes: 128 }).diff({
      cwd: root,
      kind: 'branch',
      originBranch: 'main',
      includeUncommitted: true,
    })

    expect(result.byteCount).toBe(128)
    expect(Buffer.byteLength(result.patch)).toBeLessThanOrEqual(128)
    expect(result.truncated).toBe(true)
    expect(result.warnings[0]).toContain('128')
    expect(result.files).toContainEqual(expect.objectContaining({ path: 'large.txt', additions: 100 }))
  })

  it('times out Git and matches hostile branch input only against enumerated refs', async () => {
    const root = await initRepo()
    await write(root, 'base.txt', 'base\n')
    const oid = await commitAll(root, 'base')
    await git(root, 'update-ref', 'refs/remotes/origin/main', oid)
    const marker = path.join(root, 'injected')

    await expect(new GitService().diff({
      cwd: root,
      kind: 'branch',
      originBranch: `main;touch ${marker}`,
      includeUncommitted: true,
    })).rejects.toMatchObject({ code: 'origin_branch_not_found' })
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: 'ENOENT' })

    const wrapper = path.join(await tempDir(), 'slow-git.sh')
    await fs.writeFile(wrapper, '#!/bin/sh\nsleep 1\nexec git "$@"\n', { mode: 0o755 })
    const startedAt = Date.now()
    await expect(new GitService({ gitBinary: wrapper, timeoutMs: 20 }).discoverGit(root))
      .rejects.toEqual(expect.objectContaining<Partial<GitError>>({ code: 'timeout' }))
    expect(Date.now() - startedAt).toBeLessThan(500)
  })
})
