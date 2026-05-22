import { describe, expect, it } from 'vitest'
import { resolveViteServerConfig } from '../../vite.config'

describe('resolveViteServerConfig', () => {
  it('uses launcher-provided client port and app proxy target', () => {
    const config = resolveViteServerConfig({
      CC_CLIENT_HOST: '127.0.0.1',
      CC_CLIENT_PORT: '5678',
      CC_APP_URL: 'http://127.0.0.1:3456',
    })

    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(5678)
    expect(config.proxy['/trpc']).toEqual({ target: 'http://127.0.0.1:3456', ws: true })
    expect(config.proxy['/api']).toBe('http://127.0.0.1:3456')
    expect(config.proxy['/preview']).toEqual({ target: 'http://127.0.0.1:3456', ws: true })
    expect(config.watch.ignored).toContain('**/.kaivo/**')
    expect(config.watch.ignored).toContain('**/packages/kaivo-desktop/bundle/**')
    expect(config.watch.ignored).toContain('**/packages/kaivo-desktop/release/**')
  })

  it('keeps legacy defaults for direct Vite runs', () => {
    const config = resolveViteServerConfig({})

    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(5180)
    expect(config.proxy['/healthz']).toBe('http://localhost:3000')
  })
})
