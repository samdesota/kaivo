import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildLaunchManifest, runLocalDevLauncher } from '../../scripts/local-launch'
import { resolveInstanceRuntimeConfig } from '../../packages/kaivo-desktop/src/instance-runtime'

describe('local launch manifest', () => {
  it('serializes every service without secrets', () => {
    const config = resolveInstanceRuntimeConfig(
      {
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'manifest-test',
        CC_SEED_OPENAI_API_KEY: 'sk-secret',
        CC_SERVICE_CREDENTIAL: 'local-secret-credential',
      },
      { cwd: '/tmp/cloud-code-a', homeDir: '/tmp/home' },
    )
    const manifest = buildLaunchManifest(
      config,
      {
        cwd: '/tmp/cloud-code-a',
        homeDir: '/tmp/home',
        env: {},
        mode: 'browser',
        maxAttempts: 1,
        waitMs: 1,
        pollMs: 1,
        now: () => new Date('2026-05-02T00:00:00.000Z'),
        command: 'tsx scripts/local-launch.ts',
        script: 'dev:local',
      },
      [
        { name: 'app', pid: 101, stop: async () => {} },
        { name: 'env', pid: 102, stop: async () => {} },
        { name: 'client', pid: 103, stop: async () => {} },
      ],
      'healthy',
    )

    expect(manifest.servers).toHaveLength(3)
    expect(manifest.servers.map((server) => server.name)).toEqual(['app', 'env', 'client'])
    expect(manifest.servers.every((server) => server.port > 0 && server.baseUrl && server.logPath)).toBe(true)
    expect(manifest.servers.find((server) => server.name === 'app')?.healthUrl).toBe(config.app.healthUrl)
    expect(manifest.servers.find((server) => server.name === 'env')?.healthUrl).toBe(config.env.healthUrl)
    expect(manifest.storage.appDbPath).toBe(config.app.sqlitePath)
    expect(manifest.storage.envDbPath).toBe(`${config.env.stateDir}/env.db`)
    expect(JSON.stringify(manifest)).not.toContain('sk-secret')
    expect(JSON.stringify(manifest)).not.toContain('local-secret-credential')
  })
})

describe('local launcher retry', () => {
  it('retries with fresh ports after a service health mismatch', async () => {
    const startedPorts: number[][] = []
    const writes: Array<{ status: string; ports: number[] }> = []
    let waitCalls = 0
    let stopped = 0

    const result = await runLocalDevLauncher(
      {
        cwd: '/tmp/cloud-code-a',
        homeDir: '/tmp/home',
        env: { NODE_ENV: 'production', CC_INSTANCE_ID: 'retry-test' },
        maxAttempts: 2,
        waitMs: 1,
        pollMs: 1,
        now: () => new Date('2026-05-02T00:00:00.000Z'),
        command: 'test-launch',
        script: 'test',
      },
      {
        seedApp: async () => {},
        isPortAvailable: async () => true,
        startServices: async (config) => {
          startedPorts.push([config.app.port, config.env.port, config.client.port])
          return [
            { name: 'app', pid: 201, stop: async () => { stopped += 1 } },
            { name: 'env', pid: 202, stop: async () => { stopped += 1 } },
            { name: 'client', pid: 203, stop: async () => { stopped += 1 } },
          ]
        },
        waitForServices: async () => {
          waitCalls += 1
          if (waitCalls === 1) throw new Error('app service instance mismatch: expected retry-test, got other')
        },
        pairServices: async () => {},
        writeManifest: async (_config, manifest) => {
          writes.push({ status: manifest.servers[0]?.status ?? 'missing', ports: manifest.servers.map((server) => server.port) })
        },
      },
    )

    expect(startedPorts).toHaveLength(2)
    expect(startedPorts[0]).not.toEqual(startedPorts[1])
    expect(new Set(startedPorts[1]).size).toBe(3)
    expect(stopped).toBe(3)
    expect(result.config.rootDir).toBe('/tmp/cloud-code-a/.kaivo/instances/retry-test')
    expect(result.manifest.servers.every((server) => server.status === 'healthy')).toBe(true)
    expect(writes.map((write) => write.status)).toEqual(['starting', 'failed', 'starting', 'healthy'])
  })

  it('seeds the selected app DB before service startup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-local-launch-seed-test-'))
    const result = await runLocalDevLauncher(
      {
        cwd: '/tmp/cloud-code-a',
        homeDir: '/tmp/home',
        env: {
          NODE_ENV: 'development',
          CC_INSTANCE_ID: 'launch-seed-test',
          CC_INSTANCE_ROOT: root,
          CC_SEED_OPENAI_API_KEY_OP_REF: '',
          CC_SEED_OPENAI_API_KEY: 'launch-key',
          CC_SEED_OPENAI_BASE_URL: 'http://localhost:11434/v1',
        },
        maxAttempts: 1,
        waitMs: 1,
        pollMs: 1,
        now: () => new Date('2026-05-02T00:00:00.000Z'),
        command: 'test-launch',
        script: 'test',
      },
      {
        isPortAvailable: async () => true,
        startServices: async () => [
          { name: 'app', pid: 301, stop: async () => {} },
          { name: 'env', pid: 302, stop: async () => {} },
          { name: 'client', pid: 303, stop: async () => {} },
        ],
        waitForServices: async () => {},
        pairServices: async () => {},
        writeManifest: async () => {},
      },
    )

    const { buildProviderEnvRaw } = await import('../../server/agent/providers')
    expect(result.config.app.sqlitePath).toBe(path.join(root, 'app', 'app.db'))
    expect(await buildProviderEnvRaw()).toEqual({
      OPENAI_API_KEY: 'launch-key',
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
    })
  })

  it('pairs local app and env services before reporting healthy', async () => {
    const writes: Array<{ status: string }> = []
    let pairCalled = false

    await runLocalDevLauncher(
      {
        cwd: '/tmp/cloud-code-a',
        homeDir: '/tmp/home',
        env: { NODE_ENV: 'development', CC_INSTANCE_ID: 'pair-launch-test' },
        maxAttempts: 1,
        waitMs: 1,
        pollMs: 1,
        now: () => new Date('2026-05-02T00:00:00.000Z'),
        command: 'test-launch',
        script: 'test',
      },
      {
        seedApp: async () => {},
        isPortAvailable: async () => true,
        startServices: async () => [
          { name: 'app', pid: 401, stop: async () => {} },
          { name: 'env', pid: 402, stop: async () => {} },
          { name: 'client', pid: 403, stop: async () => {} },
        ],
        waitForServices: async () => {},
        pairServices: async () => {
          expect(writes.map((write) => write.status)).toEqual(['starting'])
          pairCalled = true
        },
        writeManifest: async (_config, manifest) => {
          writes.push({ status: manifest.servers[0]?.status ?? 'missing' })
        },
      },
    )

    expect(pairCalled).toBe(true)
    expect(writes.map((write) => write.status)).toEqual(['starting', 'healthy'])
  })
})
