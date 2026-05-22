import { describe, expect, it } from 'vitest'
import { resolveDesktopConfig } from './config'
import { resolveInstanceRuntimeConfig } from './instance-runtime'

describe('resolveDesktopConfig', () => {
  it('uses the Vite dev URL in development', () => {
    expect(resolveDesktopConfig({ NODE_ENV: 'development' }).chromeUrl).toBe('http://127.0.0.1:5180')
  })

  it('uses the app server URL in production', () => {
    const config = resolveDesktopConfig({ NODE_ENV: 'production' })

    expect(config.mode).toBe('production')
    expect(config.manageServices).toBe(true)
    expect(config.chromeUrl).toBe(config.instance.app.url)
  })

  it('allows production service management to be disabled', () => {
    const config = resolveDesktopConfig({ NODE_ENV: 'production', CC_DESKTOP_MANAGE_SERVICES: 'false' })

    expect(config.manageServices).toBe(false)
  })

  it('allows a production URL override', () => {
    const config = resolveDesktopConfig({ NODE_ENV: 'production', CC_DESKTOP_PROD_URL: 'http://127.0.0.1:3100' })

    expect(config.mode).toBe('production')
    expect(config.chromeUrl).toBe('http://127.0.0.1:3100')
  })

  it('allows an explicit chrome URL override', () => {
    expect(
      resolveDesktopConfig({
        NODE_ENV: 'production',
        CC_DESKTOP_CHROME_URL: 'http://127.0.0.1:5199/login',
      }).chromeUrl,
    ).toBe('http://127.0.0.1:5199/login')
  })

  it('uses the local app URL when service management is enabled', () => {
    const config = resolveDesktopConfig(
      { NODE_ENV: 'development', CC_DESKTOP_MANAGE_SERVICES: 'true', CC_APP_PORT: '3333' },
      { cwd: '/tmp/cloud-code-a', homeDir: '/tmp/home' },
    )

    expect(config.manageServices).toBe(true)
    expect(config.chromeUrl).toBe('http://127.0.0.1:3333')
  })

  it('uses desktop auth exchange URL when a token is available for the app origin', () => {
    const config = resolveDesktopConfig(
      {
        NODE_ENV: 'development',
        CC_DESKTOP_MANAGE_SERVICES: 'true',
        CC_APP_PORT: '3333',
        CC_DESKTOP_AUTH_TOKEN: 'x'.repeat(32),
      },
      { cwd: '/tmp/cloud-code-a', homeDir: '/tmp/home' },
    )

    expect(config.chromeUrl).toBe('http://127.0.0.1:3333/internal/desktop-auth?token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&next=http%3A%2F%2F127.0.0.1%3A3333')
  })
})

describe('resolveInstanceRuntimeConfig', () => {
  it('produces stable values for one worktree and distinct values for two worktrees', () => {
    const first = resolveInstanceRuntimeConfig({ NODE_ENV: 'development' }, { cwd: '/tmp/cloud-code-a', homeDir: '/tmp/home' })
    const firstAgain = resolveInstanceRuntimeConfig({ NODE_ENV: 'development' }, { cwd: '/tmp/cloud-code-a', homeDir: '/tmp/home' })
    const second = resolveInstanceRuntimeConfig({ NODE_ENV: 'development' }, { cwd: '/tmp/cloud-code-b', homeDir: '/tmp/home' })

    expect(first).toEqual(firstAgain)
    expect(first.instanceId).not.toBe(second.instanceId)
    expect(first.app.port).not.toBe(second.app.port)
    expect(first.env.port).not.toBe(second.env.port)
    expect(first.app.sqlitePath).not.toBe(second.app.sqlitePath)
    expect(first.env.stateDir).not.toBe(second.env.stateDir)
    expect(first.env.workingDir).not.toBe(second.env.workingDir)
  })

  it('honors explicit env var overrides for ids, ports, and directories', () => {
    const config = resolveInstanceRuntimeConfig(
      {
        NODE_ENV: 'development',
        CC_INSTANCE_ID: 'custom instance',
        CC_INSTANCE_ROOT: '/tmp/custom-root',
        CC_INSTANCE_LOG_DIR: '/tmp/custom-logs',
        CC_DESKTOP_HOST: 'localhost',
        CC_APP_PORT: '3999',
        CC_APP_URL: 'http://localhost:3999/app',
        CC_APP_DATA_DIR: '/tmp/custom-app-data',
        CC_APP_SQLITE_PATH: '/tmp/custom-app.db',
        CC_APP_LOG_PATH: '/tmp/custom-app.log',
        CC_ENV_PORT: '4999',
        CC_ENV_URL: 'http://localhost:4999/env',
        CC_ENV_STATE_DIR: '/tmp/custom-env-state',
        CC_ENV_WORKING_DIR: '/tmp/custom-workspaces',
        CC_ENV_LABEL: 'Custom Env',
        CC_ENV_LOG_PATH: '/tmp/custom-env.log',
        CC_CLIENT_PORT: '5999',
        CC_CLIENT_URL: 'http://localhost:5999/client',
        CC_CLIENT_LOG_PATH: '/tmp/custom-client.log',
      },
      { cwd: '/tmp/cloud-code-a', homeDir: '/tmp/home' },
    )

    expect(config.instanceId).toBe('custom-instance')
    expect(config.rootDir).toBe('/tmp/custom-root')
    expect(config.logsDir).toBe('/tmp/custom-logs')
    expect(config.app.host).toBe('localhost')
    expect(config.app.port).toBe(3999)
    expect(config.app.url).toBe('http://localhost:3999/app')
    expect(config.app.dataDir).toBe('/tmp/custom-app-data')
    expect(config.app.sqlitePath).toBe('/tmp/custom-app.db')
    expect(config.app.logPath).toBe('/tmp/custom-app.log')
    expect(config.env.port).toBe(4999)
    expect(config.env.url).toBe('http://localhost:4999/env')
    expect(config.env.stateDir).toBe('/tmp/custom-env-state')
    expect(config.env.workingDir).toBe('/tmp/custom-workspaces')
    expect(config.env.label).toBe('Custom Env')
    expect(config.env.logPath).toBe('/tmp/custom-env.log')
    expect(config.client.host).toBe('localhost')
    expect(config.client.port).toBe(5999)
    expect(config.client.url).toBe('http://localhost:5999/client')
    expect(config.client.logPath).toBe('/tmp/custom-client.log')
  })

  it('uses packaged app identity for production defaults', () => {
    const config = resolveInstanceRuntimeConfig(
      { NODE_ENV: 'production', CC_DESKTOP_APP_ID: 'Kaivo Beta' },
      { cwd: '/worktree', homeDir: '/Users/sam' },
    )

    expect(config.instanceId).toBe('kaivo-beta')
    expect(config.rootDir).toBe('/Users/sam/Library/Application Support/kaivo-beta/instances/kaivo-beta')
    expect(config.env.workingDir).toBe('/Users/sam/d')
  })

  it('describes collision-safe persisted port selection without launching services', () => {
    const config = resolveInstanceRuntimeConfig(
      { NODE_ENV: 'development', CC_INSTANCE_ID: 'ports' },
      {
        cwd: '/tmp/cloud-code-a',
        homeDir: '/tmp/home',
        persistedPorts: { app: 3333, env: 4888 },
        portAvailability: (port, service) => {
          if (service === 'app' && port === 3333) return 'same-instance'
          if (service === 'env' && port === 4888) return 'occupied'
          return 'available'
        },
      },
    )

    expect(config.app.port).toBe(3333)
    expect(config.app.portSelection).toEqual({ port: 3333, source: 'persisted', shouldPersist: false })
    expect(config.env.port).not.toBe(4888)
    expect(config.env.portSelection.source).toMatch(/preferred|fallback/)
    expect(config.env.portSelection.shouldPersist).toBe(true)
  })
})
