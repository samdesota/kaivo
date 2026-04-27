import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveInstanceRuntimeConfig } from './instance-runtime'
import { ensureDesktopPairing } from './desktop-pairing'

describe('ensureDesktopPairing', () => {
  const children: ChildProcessWithoutNullStreams[] = []

  afterEach(async () => {
    await Promise.all(children.splice(0).map(stopChild))
  })

  it('refuses mismatched env instances and pairs the matching one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desktop-pairing-test-'))
    const envPort = await freePort()
    const config = resolveInstanceRuntimeConfig(
      {
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'pairing-a',
        CC_INSTANCE_ROOT: root,
        CC_APP_PORT: String(await freePort()),
        CC_ENV_PORT: String(envPort),
      },
      { cwd: process.cwd(), homeDir: root },
    )
    children.push(spawn('node', ['node_modules/.bin/tsx', 'server/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        APP_SQLITE_PATH: config.app.sqlitePath,
        DATA_DIR: config.app.dataDir,
        PORT: String(config.app.port),
        HOST: config.app.host,
        CC_SERVICE_CREDENTIAL: 'test-service-credential-min-16-chars',
      },
    }))
    children.push(spawn('node', ['node_modules/.bin/tsx', 'packages/env-server/src/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        CC_KIND: 'local',
        CC_INSTANCE_ID: 'pairing-a',
        CC_LABEL: config.env.label,
        CC_PORT: String(envPort),
        CC_HOST: config.env.host,
        CC_STATE_DIR: config.env.stateDir,
        CC_WORKING_DIR: config.env.workingDir,
        CC_IDENTITY_URL: config.app.url,
      },
    }))
    await waitForHealth(`${config.app.url}/healthz`)
    await waitForHealth(`${config.env.url}/healthz`)

    const mismatched = { ...config, instanceId: 'wrong-instance' }
    await expect(ensureDesktopPairing(mismatched)).rejects.toThrow(/desktop pairing failed: 409/)

    const first = await ensureDesktopPairing(config)
    const second = await ensureDesktopPairing(config)

    expect(first.reused).toBe(false)
    expect(second).toEqual({ ...first, reused: true })
    const row = await fetchJson(`${config.app.url}/internal/local-env/${first.envId}`)
    expect(row).toMatchObject({ id: first.envId, envToken: first.envToken })
  }, 15_000)
})

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    setTimeout(resolve, 1000).unref()
  })
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  if (!address || typeof address === 'string') throw new Error('failed to allocate port')
  return address.port
}

async function waitForHealth(url: string): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('health timed out')
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`request failed: ${response.status}`)
  return response.json()
}
