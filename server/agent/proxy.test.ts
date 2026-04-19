import { describe, expect, it } from 'vitest'
import {
  parseAgentCookie,
  parseAgentReferer,
  parseAgentUrl,
  rewriteAssetPaths,
} from './proxy.js'

describe('parseAgentUrl', () => {
  it('parses the bare /sandbox/:id/agent root', () => {
    expect(parseAgentUrl('/sandbox/abc123/agent')).toEqual({
      sandboxId: 'abc123',
      rest: '/',
    })
  })

  it('parses /sandbox/:id/agent/ with trailing slash', () => {
    expect(parseAgentUrl('/sandbox/abc123/agent/')).toEqual({
      sandboxId: 'abc123',
      rest: '/',
    })
  })

  it('strips the prefix and preserves the subpath', () => {
    expect(parseAgentUrl('/sandbox/abc/agent/assets/index.js')).toEqual({
      sandboxId: 'abc',
      rest: '/assets/index.js',
    })
  })

  it('preserves the query string', () => {
    expect(parseAgentUrl('/sandbox/abc/agent/api/session?id=123')).toEqual({
      sandboxId: 'abc',
      rest: '/api/session?id=123',
    })
  })

  it('rejects non-matching paths', () => {
    expect(parseAgentUrl('/sandbox/abc')).toBeNull()
    expect(parseAgentUrl('/preview/abc/5173/')).toBeNull()
    expect(parseAgentUrl('/sandbox//agent/')).toBeNull()
    expect(parseAgentUrl('/sandbox/abc/agentx')).toBeNull()
  })
})

describe('parseAgentReferer', () => {
  it('rescues an OpenCode API request originating from the agent iframe', () => {
    expect(parseAgentReferer('/agent', 'https://host/sandbox/abc/agent/')).toEqual({
      sandboxId: 'abc',
      rest: '/agent',
    })
  })

  it('rescues a root request from a deeper iframe path', () => {
    expect(parseAgentReferer('/session', 'https://host/sandbox/abc/agent/ui')).toEqual({
      sandboxId: 'abc',
      rest: '/session',
    })
  })

  it('ignores missing or unrelated referers', () => {
    expect(parseAgentReferer('/session', undefined)).toBeNull()
    expect(parseAgentReferer('/session', 'https://host/')).toBeNull()
    expect(parseAgentReferer('/session', 'not a url')).toBeNull()
  })

  it('does not steal reserved-prefix paths', () => {
    const ref = 'https://host/sandbox/abc/agent/'
    expect(parseAgentReferer('/trpc/auth.status', ref)).toBeNull()
    expect(parseAgentReferer('/preview/xyz/5173/foo', ref)).toBeNull()
    expect(parseAgentReferer('/api/github/callback', ref)).toBeNull()
    expect(parseAgentReferer('/sandbox/other/agent/', ref)).toBeNull()
    expect(parseAgentReferer('/healthz', ref)).toBeNull()
    // Main-app SPA assets must not be swallowed by rescue.
    expect(parseAgentReferer('/assets/index-abc.js', ref)).toBeNull()
  })
})

describe('parseAgentCookie', () => {
  it('rescues a request whose cookie carries the sandbox id', () => {
    expect(parseAgentCookie('/command', 'ccenv_agent_sandbox=abc; other=1')).toEqual({
      sandboxId: 'abc',
      rest: '/command',
    })
  })

  it('ignores missing cookie', () => {
    expect(parseAgentCookie('/command', undefined)).toBeNull()
    expect(parseAgentCookie('/command', 'other=1')).toBeNull()
  })

  it('does not steal reserved paths even with cookie', () => {
    const c = 'ccenv_agent_sandbox=abc'
    expect(parseAgentCookie('/trpc/auth.status', c)).toBeNull()
    expect(parseAgentCookie('/assets/main.js', c)).toBeNull()
    expect(parseAgentCookie('/api/x', c)).toBeNull()
    expect(parseAgentCookie('/healthz', c)).toBeNull()
  })
})

describe('rewriteAssetPaths', () => {
  it('rewrites <script src="/assets/">', () => {
    const out = rewriteAssetPaths(
      '<script type="module" src="/assets/index-abc.js"></script>',
      'sb123',
    )
    expect(out).toBe(
      '<script type="module" src="/sandbox/sb123/agent/assets/index-abc.js"></script>',
    )
  })

  it('rewrites dynamic import string literals', () => {
    const out = rewriteAssetPaths(
      'const mod = import("/assets/dialog-xyz.js");',
      'sb',
    )
    expect(out).toContain('import("/sandbox/sb/agent/assets/dialog-xyz.js")')
  })

  it('rewrites CSS url(/assets/...) references', () => {
    const out = rewriteAssetPaths(
      '@font-face { src: url(/assets/font.woff2); }',
      'sb',
    )
    expect(out).toContain('url(/sandbox/sb/agent/assets/font.woff2)')
  })

  it('does not rewrite absolute URLs', () => {
    const input = 'fetch("https://cdn.example.com/assets/foo.json")'
    expect(rewriteAssetPaths(input, 'sb')).toBe(input)
  })

  it('leaves non-/assets strings alone', () => {
    const input = '{"path": "/api/v1/assets"}'
    expect(rewriteAssetPaths(input, 'sb')).toBe(input)
  })
})
