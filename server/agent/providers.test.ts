import { describe, expect, it } from 'vitest'
import { rewriteLoopbackForSandbox } from './providers.js'

describe('rewriteLoopbackForSandbox', () => {
  it('rewrites localhost to host.docker.internal', () => {
    expect(rewriteLoopbackForSandbox('http://localhost:8137')).toBe(
      'http://host.docker.internal:8137/',
    )
  })

  it('rewrites 127.0.0.1', () => {
    expect(rewriteLoopbackForSandbox('http://127.0.0.1:8137/v1')).toBe(
      'http://host.docker.internal:8137/v1',
    )
  })

  it('rewrites 0.0.0.0', () => {
    expect(rewriteLoopbackForSandbox('http://0.0.0.0:9000/')).toBe(
      'http://host.docker.internal:9000/',
    )
  })

  it('passes external URLs through unchanged', () => {
    const input = 'https://api.anthropic.com/v1'
    expect(rewriteLoopbackForSandbox(input)).toBe(input)
  })

  it('passes junk through unchanged', () => {
    const input = 'not a url'
    expect(rewriteLoopbackForSandbox(input)).toBe(input)
  })
})
