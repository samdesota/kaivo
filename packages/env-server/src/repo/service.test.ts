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
  config: { CC_WORKING_DIR: testState.tmpRoot },
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
  it('full clone path is returned and config files are materialized', async () => {
    const { repoService } = await import('./service.js')

    const result = await repoService.cloneConfig('cfg-1')

    expect(result.configId).toBe('cfg-1')
    expect(result.workingDir).toContain(path.join(testState.tmpRoot, 'repos', 'project-one-'))
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
  })

  it('invalid config maps to not_found', async () => {
    const { RepoError, repoService } = await import('./service.js')

    await expect(repoService.cloneConfig('missing')).rejects.toBeInstanceOf(RepoError)
    await expect(repoService.cloneConfig('missing')).rejects.toMatchObject({ code: 'not_found' })
  })
})
