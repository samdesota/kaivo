import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('env-server config instance id', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults the instance id', async () => {
    vi.resetModules()
    vi.stubEnv('CC_WORKING_DIR', '/tmp')
    vi.stubEnv('CC_IDENTITY_URL', 'https://code.438d.xyz')
    vi.stubEnv('CC_STATE_DIR', tempStateDir())

    const { config } = await import('./config.js')

    expect(config.CC_INSTANCE_ID).toBe('default')
  })

  it('reads the instance id from CC_INSTANCE_ID', async () => {
    vi.resetModules()
    vi.stubEnv('CC_WORKING_DIR', '/tmp')
    vi.stubEnv('CC_IDENTITY_URL', 'https://code.438d.xyz')
    vi.stubEnv('CC_STATE_DIR', tempStateDir())
    vi.stubEnv('CC_INSTANCE_ID', 'dev-worktree-a')

    const { config } = await import('./config.js')

    expect(config.CC_INSTANCE_ID).toBe('dev-worktree-a')
  })
})

function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-env-config-test-'))
}
