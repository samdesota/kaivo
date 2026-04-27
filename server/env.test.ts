import { afterEach, describe, expect, it, vi } from 'vitest'

describe('server env local sqlite validation', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses SQLite app storage without Postgres configuration', async () => {
    vi.resetModules()
    vi.stubEnv('DATA_DIR', '/tmp/cc-local-env-test')
    vi.stubEnv('APP_SQLITE_PATH', '/tmp/cc-local-env-test/app.db')
    vi.stubEnv('CC_SERVICE_CREDENTIAL', 'test-service-credential-min-16-chars')

    const { env } = await import('./env.js')

    expect(env.APP_SQLITE_PATH).toBe('/tmp/cc-local-env-test/app.db')
    expect(env.SANDBOX_BASE_IMAGE).toBe('cloud-code-sandbox:dev')
    expect(env.DOCKER_NETWORK).toBe('cloud-code-net')
  })
})
