import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir = ''

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-opencode-test-'))
  vi.resetModules()
  vi.stubEnv('CC_WORKING_DIR', tempDir)
  vi.stubEnv('CC_IDENTITY_URL', 'https://code.438d.xyz')
  vi.stubEnv('CC_STATE_DIR', path.join(tempDir, 'state'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
})

describe('opencode user plugin config', () => {
  it('merges user plugins after required Kaivo plugins without duplicates', async () => {
    const { mergePluginLists } = await import('./opencode.js')

    expect(mergePluginLists(['file:///kaivo.js', 'oc-codex-multi-auth'], ['@tarquinen/opencode-dcp@3.1.12', 'oc-codex-multi-auth'])).toEqual([
      'file:///kaivo.js',
      'oc-codex-multi-auth',
      '@tarquinen/opencode-dcp@3.1.12',
    ])
  })

  it('reads plugin arrays from user opencode json and jsonc files', async () => {
    const configDir = path.join(tempDir, '.config', 'opencode')
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, 'opencode.json'), JSON.stringify({ plugin: ['opencode-wakatime'] }))
    await fs.writeFile(path.join(configDir, 'opencode.jsonc'), `{
      // User plugins should be additive only.
      "plugin": ["@tarquinen/opencode-dcp@3.1.12"]
    }`)

    const { readUserOpenCodePlugins } = await import('./opencode.js')

    await expect(readUserOpenCodePlugins(configDir)).resolves.toEqual([
      'opencode-wakatime',
      '@tarquinen/opencode-dcp@3.1.12',
    ])
  })
})
