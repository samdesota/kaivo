import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function expectedBasicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
}

async function loadHooks() {
  const { agentProxyTestHooks } = await import('./proxy.js')
  return agentProxyTestHooks
}

describe('agent proxy header handling', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('CC_KIND', 'local')
    vi.stubEnv('CC_WORKING_DIR', '/tmp')
    vi.stubEnv('CC_IDENTITY_URL', 'https://code.438d.xyz')
    vi.stubEnv('CC_STATE_DIR', '/tmp/kaivo-agent-proxy-test')
    vi.stubEnv('CC_INSTANCE_ID', 'agent-proxy-test')
    vi.stubEnv('CC_LABEL', 'Agent Proxy Test')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rewrites frontend env-token auth to internal OpenCode Basic auth', () => {
    return loadHooks().then((agentProxyTestHooks) => {
    const headers = agentProxyTestHooks.filterRequestHeaders({
      authorization: 'Bearer env-token-from-browser',
      host: 'env.local:47821',
      connection: 'keep-alive',
      'accept-encoding': 'gzip, br',
      'x-opencode-directory': '/tmp/project',
      'x-custom': 'preserved',
    }, '127.0.0.1:49123', 'opencode-secret')

    expect(headers.authorization).toBe(expectedBasicAuth('opencode-secret'))
    expect(headers.authorization).not.toContain('env-token-from-browser')
    expect(headers.host).toBe('127.0.0.1:49123')
    expect(headers['accept-encoding']).toBe('identity')
    expect(headers.connection).toBeUndefined()
    expect(headers['x-opencode-directory']).toBe('/tmp/project')
    expect(headers['x-custom']).toBe('preserved')
    })
  })

  it('strips response headers that should not leak through the gateway', async () => {
    const agentProxyTestHooks = await loadHooks()
    const headers = agentProxyTestHooks.filterResponseHeaders({
      'content-type': 'application/json',
      'content-security-policy': "default-src 'none'",
      'x-frame-options': 'DENY',
      connection: 'close',
    })

    expect(headers['content-type']).toBe('application/json')
    expect(headers['content-security-policy']).toBeUndefined()
    expect(headers['x-frame-options']).toBeUndefined()
    expect(headers.connection).toBeUndefined()
  })

  it('preserves raw OpenCode paths behind the /agent prefix', async () => {
    const agentProxyTestHooks = await loadHooks()
    expect(agentProxyTestHooks.stripAgentPrefix('/agent/session/abc/message?limit=20')).toBe('/session/abc/message?limit=20')
    expect(agentProxyTestHooks.stripAgentPrefix('/agent?x=1')).toBe('?x=1')
  })
})
