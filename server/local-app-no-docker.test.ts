import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

describe('local app boot without Docker', () => {
  let child: ChildProcessWithoutNullStreams | null = null

  afterEach(async () => {
    if (!child || child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      child?.once('exit', () => resolve())
      setTimeout(resolve, 1000).unref()
    })
    child = null
  })

  it('serves /healthz with SQLite and an unusable Docker socket', async () => {
    const port = await freePort()
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-local-no-docker-'))
    const env = { ...process.env }
    child = spawn('npx', ['tsx', 'server/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...env,
        NODE_ENV: 'test',
        APP_SQLITE_PATH: path.join(dataDir, 'app.db'),
        DATA_DIR: dataDir,
        PORT: String(port),
        HOST: '127.0.0.1',
        DOCKER_HOST: 'unix:///tmp/cloud-code-missing-docker.sock',
        CC_SERVICE_CREDENTIAL: 'test-service-credential-min-16-chars',
      },
    })

    const response = await waitForHealth(`http://127.0.0.1:${port}/healthz`)

    expect(response).toMatchObject({ ok: true, instanceId: 'default' })
  }, 15_000)
})

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  if (!address || typeof address === 'string') throw new Error('failed to allocate port')
  return address.port
}

async function waitForHealth(url: string): Promise<unknown> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < 10_000) {
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
      lastError = new Error(`health returned ${response.status}`)
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
