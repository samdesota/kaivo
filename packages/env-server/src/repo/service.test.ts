import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = vi.hoisted(() => ({
  tmpRoot: '',
  configMissing: false,
  cloneArgs: [] as string[][],
}))

vi.mock('../config.js', () => ({
  config: { CC_WORKING_DIR: testState.tmpRoot, CC_STATE_DIR: testState.tmpRoot },
}))

vi.mock('../identity/client.js', () => ({
  listRepoConfigs: async () => [
    { id: 'cfg-1', name: 'Project One', originUrl: 'https://example.com/project-one.git', ref: 'main', githubFullName: null },
  ],
  getRepoConfig: async (configId: string) => {
    if (testState.configMissing || configId === 'missing') throw new Error('not found')
    return {
      summary: {
        id: configId,
        name: 'Project One',
        originUrl: 'https://example.com/project-one.git',
        ref: 'main',
        githubFullName: null,
      },
      files: [{ path: '.cloud/model.json', contents: '{"model":"gpt-5.5"}' }],
    }
  },
}))

vi.mock('node:child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    testState.cloneArgs.push(args)
    const em = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
    em.stderr = new EventEmitter()
    const target = args.at(-1)
    queueMicrotask(async () => {
      if (target) await fs.mkdir(target, { recursive: true })
      em.emit('exit', 0)
    })
    return em
  },
}))

beforeEach(async () => {
  testState.tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-service-'))
  testState.configMissing = false
  testState.cloneArgs = []
  vi.resetModules()
})

afterEach(async () => {
  await fs.rm(testState.tmpRoot, { recursive: true, force: true })
})

describe('repo service', () => {
  async function setupRepoService() {
    const [{ repoService }, { sqliteRaw }] = await Promise.all([
      import('./service.js'),
      import('../db/client.js'),
    ])
    sqliteRaw.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        config_id TEXT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        worktree_name TEXT,
        worktree_slug TEXT,
        origin_url TEXT NOT NULL,
        ref TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('github','url')),
        github_repo_id TEXT,
        github_full_name TEXT,
        workspace_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    return repoService
  }

  it('full clone path is returned and config files are materialized', async () => {
    const repoService = await setupRepoService()

    const result = await repoService.cloneConfig('cfg-1', 'Bug Shell Resize')

    expect(result.configId).toBe('cfg-1')
    expect(result.workingDir).toBe(path.join(testState.tmpRoot, 'repos', 'project-one', 'bug-shell-resize'))
    expect(testState.cloneArgs[0]).toEqual([
      'clone',
      '--progress',
      '--branch',
      'main',
      'https://example.com/project-one.git',
      result.workingDir,
    ])
    await expect(fs.readFile(path.join(result.workingDir, '.cloud/model.json'), 'utf8')).resolves.toBe(
      '{"model":"gpt-5.5"}',
    )
    expect(repoService.listWorktrees()).toMatchObject([
      {
        configId: 'cfg-1',
        name: 'Project One',
        slug: 'project-one',
        worktreeName: 'Bug Shell Resize',
        worktreeSlug: 'bug-shell-resize',
        workingDir: result.workingDir,
      },
    ])
  })

  it('deletes a cloned work tree', async () => {
    const repoService = await setupRepoService()

    const result = await repoService.cloneConfig('cfg-1', 'Cleanup Me')

    await repoService.deleteWorktree(result.repoId)

    await expect(fs.stat(result.workingDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(repoService.listWorktrees()).toEqual([])
  })

  it('invalid config maps to not_found', async () => {
    const [{ RepoError }, repoService] = await Promise.all([
      import('./service.js'),
      setupRepoService(),
    ])

    await expect(repoService.cloneConfig('missing', 'demo')).rejects.toBeInstanceOf(RepoError)
    await expect(repoService.cloneConfig('missing', 'demo')).rejects.toMatchObject({ code: 'not_found' })
  })
})
