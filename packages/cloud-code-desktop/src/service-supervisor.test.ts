import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { resolveInstanceRuntimeConfig } from './instance-runtime'
import { ensureDesktopServices, type ServiceName, type ServiceLaunchSpec } from './service-supervisor'

describe('ensureDesktopServices', () => {
  it('reuses matching running services', async () => {
    const config = resolveInstanceRuntimeConfig(
      { NODE_ENV: 'development', CC_INSTANCE_ID: 'supervisor-a' },
      { cwd: '/tmp/cloud-code-a', homeDir: '/tmp/home' },
    )

    const supervisor = await ensureDesktopServices(config, {
      fetchHealth: async (url) => {
        if (url === `${config.app.url}/healthz`) return { ok: true, instanceId: config.instanceId }
        if (url === `${config.env.url}/healthz`) return { ok: true, instanceId: config.instanceId, label: config.env.label }
        return null
      },
      launch: () => {
        throw new Error('launch should not be called')
      },
      pair: async () => ({ envId: `local-${config.instanceId}`, envToken: 'test-token', reused: true }),
    })

      expect(supervisor.app.launched).toBe(false)
      expect(supervisor.env.launched).toBe(false)
      expect(supervisor.pairing).toEqual({ envId: `local-${config.instanceId}`, envToken: 'test-token', reused: true })
  })

  it('rejects a running env with the wrong instance id', async () => {
    const config = resolveInstanceRuntimeConfig(
      { NODE_ENV: 'development', CC_INSTANCE_ID: 'supervisor-a' },
      { cwd: '/tmp/cloud-code-a', homeDir: '/tmp/home' },
    )

    await expect(
      ensureDesktopServices(config, {
        fetchHealth: async (url) => {
          if (url === `${config.app.url}/healthz`) return { ok: true, instanceId: config.instanceId }
          if (url === `${config.env.url}/healthz`) return { ok: true, instanceId: 'other-instance' }
          return null
        },
        launch: fakeLaunch,
        pair: async () => ({ envId: `local-${config.instanceId}`, envToken: 'test-token', reused: true }),
      }),
    ).rejects.toThrow(/instance mismatch/)
  })

  it('launches local app and cc-env services into temp instance directories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-supervisor-test-'))
    const appPort = await freePort()
    const envPort = await freePort()
    const config = resolveInstanceRuntimeConfig(
      {
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'supervisor-integration',
        CC_INSTANCE_ROOT: root,
        CC_APP_PORT: String(appPort),
        CC_ENV_PORT: String(envPort),
      },
      { cwd: process.cwd(), homeDir: root },
    )

    const supervisor = await ensureDesktopServices(config, { cwd: process.cwd(), waitMs: 15_000 })

    try {
      expect(supervisor.app.launched).toBe(true)
      expect(supervisor.env.launched).toBe(true)
      expect(supervisor.pairing.reused).toBe(false)
      await expect(fetchJson(`${config.app.url}/healthz`)).resolves.toMatchObject({ ok: true, instanceId: config.instanceId })
      await expect(fetchJson(`${config.env.url}/healthz`)).resolves.toMatchObject({
        ok: true,
        instanceId: config.instanceId,
        label: config.env.label,
      })
      const sqlite = new Database(config.app.sqlitePath, { readonly: true })
      try {
        const row = sqlite.prepare('SELECT id, kind, label, url, env_token FROM envs WHERE id = ?').get(`local-${config.instanceId}`)
        expect(row).toMatchObject({
          id: `local-${config.instanceId}`,
          kind: 'local',
          label: config.env.label,
          url: config.env.url,
          env_token: supervisor.pairing.envToken,
        })
      } finally {
        sqlite.close()
      }
    } finally {
      await supervisor.stop()
    }
  }, 20_000)
})

function fakeLaunch(_service: ServiceName, _spec: ServiceLaunchSpec) {
  const emitter = new EventEmitter() as never
  return Object.assign(emitter, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
    kill: () => true,
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

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`request failed: ${response.status}`)
  return response.json()
}
