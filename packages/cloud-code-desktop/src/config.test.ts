import { describe, expect, it } from 'vitest'
import { resolveDesktopConfig } from './config'

describe('resolveDesktopConfig', () => {
  it('uses the Vite dev URL in development', () => {
    expect(resolveDesktopConfig({ NODE_ENV: 'development' }).chromeUrl).toBe('http://127.0.0.1:5180')
  })

  it('uses the app server URL in production', () => {
    expect(resolveDesktopConfig({ NODE_ENV: 'production', PORT: '3100' })).toEqual({
      mode: 'production',
      chromeUrl: 'http://127.0.0.1:3100',
    })
  })

  it('allows an explicit chrome URL override', () => {
    expect(
      resolveDesktopConfig({
        NODE_ENV: 'production',
        CC_DESKTOP_CHROME_URL: 'http://127.0.0.1:5199/login',
      }).chromeUrl,
    ).toBe('http://127.0.0.1:5199/login')
  })
})
