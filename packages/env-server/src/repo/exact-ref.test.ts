import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const exec = promisify(execFile)
const state = vi.hoisted(() => ({ root: '', origin: '' }))

vi.mock('../config.js', () => ({
  config: { get CC_WORKING_DIR() { return state.root }, get CC_STATE_DIR() { return state.root } },
}))

vi.mock('../identity/client.js', () => ({
  listRepoConfigs: async () => [],
  getRepoConfig: async (configId: string) => ({
    summary: { id: configId, name: 'Exact Repo', originUrl: state.origin, ref: 'main', source: 'url', githubFullName: null },
    files: [],
  }),
}))

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', args, { cwd })).stdout.trim()
}

beforeEach(async () => {
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'exact-ref-'))
  const source = path.join(state.root, 'source')
  state.origin = path.join(state.root, 'origin.git')
  await fs.mkdir(source)
  await git(source, 'init', '-b', 'main')
  await git(source, 'config', 'user.email', 'test@example.com')
  await git(source, 'config', 'user.name', 'Test')
  await fs.writeFile(path.join(source, 'value.txt'), 'one')
  await git(source, 'add', '.')
  await git(source, 'commit', '-m', 'one')
  await git(source, 'tag', 'v1')
  await fs.writeFile(path.join(source, 'value.txt'), 'two')
  await git(source, 'commit', '-am', 'two')
  await git(source, 'branch', 'occupied')
  await git(state.root, 'clone', '--bare', source, state.origin)
  vi.resetModules()
})

afterEach(async () => {
  const client = await import('../db/client.js').catch(() => null)
  if (client?.sqliteRaw.open) client.sqliteRaw.close()
  await fs.rm(state.root, { recursive: true, force: true })
})

async function setup() {
  const [{ repoService }, { sqliteRaw }] = await Promise.all([import('./service.js'), import('../db/client.js')])
  sqliteRaw.exec(`
    CREATE TABLE repos (
      id TEXT PRIMARY KEY, config_id TEXT, name TEXT NOT NULL, slug TEXT NOT NULL,
      worktree_name TEXT, worktree_slug TEXT, origin_url TEXT NOT NULL, ref TEXT NOT NULL,
      workspace_path TEXT NOT NULL UNIQUE, source TEXT NOT NULL, github_repo_id TEXT,
      github_full_name TEXT, created_at TEXT NOT NULL, workspace_id TEXT
    )
  `)
  return repoService
}

describe('exact-ref repository provisioning', () => {
  it('provisions branch, tag, and commit refs onto explicit branches', async () => {
    const service = await setup()
    const source = path.join(state.root, 'source')
    const firstCommit = await git(source, 'rev-parse', 'v1^{commit}')
    const latestCommit = await git(source, 'rev-parse', 'main^{commit}')
    const inputs = [
      { worktreeName: 'from-branch', sourceRef: 'main', branchName: 'task/branch', commit: latestCommit },
      { worktreeName: 'from-tag', sourceRef: 'v1', branchName: 'task/tag', commit: firstCommit },
      { worktreeName: 'from-commit', sourceRef: firstCommit, branchName: 'task/commit', commit: firstCommit },
    ]
    for (const input of inputs) {
      const result = await service.cloneConfigAtRef({ configId: 'cfg', workspaceId: 'ws', ...input })
      expect(await git(result.workingDir, 'rev-parse', 'HEAD')).toBe(input.commit)
      expect(await git(result.workingDir, 'branch', '--show-current')).toBe(input.branchName)
      expect(result.resolvedCommit).toBe(input.commit)
    }
  })

  it('rejects unresolved refs, path collisions, and source branch collisions without cleanup fallback', async () => {
    const service = await setup()
    await expect(service.cloneConfigAtRef({
      configId: 'cfg', workspaceId: 'ws', worktreeName: 'missing-ref', sourceRef: 'does-not-exist', branchName: 'task/missing',
    })).rejects.toMatchObject({ code: 'ref_not_found' })
    const unrelated = path.join(state.root, 'repos', 'exact-repo', 'occupied-path')
    await fs.mkdir(unrelated, { recursive: true })
    await fs.writeFile(path.join(unrelated, 'keep'), 'safe')
    await expect(service.cloneConfigAtRef({
      configId: 'cfg', workspaceId: 'ws', worktreeName: 'occupied-path', sourceRef: 'main', branchName: 'task/path',
    })).rejects.toMatchObject({ code: 'already_exists' })
    await expect(fs.readFile(path.join(unrelated, 'keep'), 'utf8')).resolves.toBe('safe')
    await expect(service.cloneConfigAtRef({
      configId: 'cfg', workspaceId: 'ws', worktreeName: 'branch-conflict', sourceRef: 'main', branchName: 'occupied',
    })).rejects.toMatchObject({ code: 'branch_conflict' })
  })
})
