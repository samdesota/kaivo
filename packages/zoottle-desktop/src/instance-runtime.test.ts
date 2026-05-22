import { describe, expect, it } from 'vitest'
import { resolveInstanceRuntimeConfig, selectRuntimePorts } from './instance-runtime'

describe('instance runtime ports', () => {
  it('resolves a client dev server port with the same per-worktree runtime model', () => {
    const first = resolveInstanceRuntimeConfig({ NODE_ENV: 'development' }, { cwd: '/tmp/kaivo-a', homeDir: '/tmp/home' })
    const second = resolveInstanceRuntimeConfig({ NODE_ENV: 'development' }, { cwd: '/tmp/kaivo-b', homeDir: '/tmp/home' })

    expect(first.client.url).toBe(`http://127.0.0.1:${first.client.port}`)
    expect(first.client.logPath).toBe(`${first.logsDir}/client.log`)
    expect(first.client.port).not.toBe(second.client.port)
    expect(new Set([first.app.port, first.env.port, first.client.port]).size).toBe(3)
  })

  it('honors explicit client overrides without using fixed local dev ports', () => {
    const config = resolveInstanceRuntimeConfig(
      {
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'runtime-ports',
        CC_APP_PORT: '3001',
        CC_ENV_PORT: '47822',
        CC_CLIENT_PORT: '5181',
      },
      { cwd: '/tmp/kaivo-a', homeDir: '/tmp/home' },
    )

    expect(config.app.port).toBe(3001)
    expect(config.env.port).toBe(47822)
    expect(config.client.port).toBe(5181)
    expect([config.app.port, config.env.port, config.client.port]).not.toContain(3000)
    expect([config.app.port, config.env.port, config.client.port]).not.toContain(47821)
    expect([config.app.port, config.env.port, config.client.port]).not.toContain(5180)
  })

  it('returns a complete non-conflicting service port set', () => {
    const ports = selectRuntimePorts({
      preferred: { app: 3100, env: 48000, client: 5100 },
      portAvailability: (port) => (port === 3100 || port === 48000 || port === 5100 ? 'occupied' : 'available'),
    })

    expect(ports.app).toEqual({ port: 3101, source: 'fallback', shouldPersist: true })
    expect(ports.env).toEqual({ port: 48001, source: 'fallback', shouldPersist: true })
    expect(ports.client).toEqual({ port: 5101, source: 'fallback', shouldPersist: true })
    expect(new Set([ports.app.port, ports.env.port, ports.client.port]).size).toBe(3)
  })

  it('rejects override collisions across services', () => {
    expect(() =>
      selectRuntimePorts({
        overrides: { app: '3333', env: '3333' },
        preferred: { app: 3100, env: 48000, client: 5100 },
        portAvailability: () => 'available',
      }),
    ).toThrow(/already selected|selected for both/)
  })
})
