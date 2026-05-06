import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserService } from '../../browser/agent-browser-service.js'

const tokenSandboxes = new Map<string, string>()

vi.mock('../../agent/token.js', () => ({
  verifyAgentShellToken: async (token: string) => {
    const sandboxId = tokenSandboxes.get(token)
    return sandboxId ? { sandboxId } : null
  },
}))

async function load() {
  const [{ appRouter }, service] = await Promise.all([
    import('../router.js'),
    import('../../browser/agent-browser-service.js'),
  ])
  return { createCaller: appRouter.createCaller, service }
}

function makeCtx(opts: { bearer?: string; cookieSession?: boolean }) {
  const headers: Record<string, string> = {}
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  return {
    req: { headers } as unknown as import('@trpc/server/adapters/fastify').CreateFastifyContextOptions['req'],
    res: {} as unknown as import('@trpc/server/adapters/fastify').CreateFastifyContextOptions['res'],
    ip: '127.0.0.1',
    session: opts.cookieSession
      ? ({ id: 'sess-1', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), lastSeen: new Date() } as import('../../auth/service.js').Session)
      : null,
  }
}

function fakeBrowserService(): AgentBrowserService {
  return {
    async listTabs(scope) {
      return [
        {
          browserTabId: `tab-${scope.sandboxId}`,
          url: 'https://example.com',
          title: scope.opencodeSessionId,
          active: true,
          connected: false,
          connectedByCurrentAgent: false,
        },
      ]
    },
    async connectTab() {
      throw new Error('unused')
    },
    async openAndConnect() {
      throw new Error('unused')
    },
    async disconnect() {
      throw new Error('unused')
    },
    async snapshot() {
      throw new Error('unused')
    },
    async interact() {
      throw new Error('unused')
    },
    async screenshot() {
      throw new Error('unused')
    },
    async executeJs() {
      throw new Error('unused')
    },
  }
}

describe('agentBrowser app router', () => {
  beforeEach(() => {
    tokenSandboxes.clear()
    vi.resetModules()
  })

  it('rejects unauthenticated calls', async () => {
    const { createCaller } = await load()
    const caller = createCaller(makeCtx({}))

    await expect(
      caller.agentBrowser.listTabs({ opencodeSessionId: 'oc-1' }),
    ).rejects.toThrow(/bearer token or admin cookie/i)
  })

  it('rejects cross-sandbox token calls before invoking the browser service', async () => {
    tokenSandboxes.set('token-a', 'sb-a')
    const { createCaller, service } = await load()
    const restore = service.setAgentBrowserServiceForTests(fakeBrowserService())
    const caller = createCaller(makeCtx({ bearer: 'token-a' }))

    try {
      await expect(
        caller.agentBrowser.listTabs({ sandboxId: 'sb-b', opencodeSessionId: 'oc-1' }),
      ).rejects.toThrow(/scoped to a different sandbox/i)
    } finally {
      restore()
    }
  })

  it('scopes valid token calls to the token sandbox', async () => {
    tokenSandboxes.set('token-a', 'sb-a')
    const { createCaller, service } = await load()
    const restore = service.setAgentBrowserServiceForTests(fakeBrowserService())
    const caller = createCaller(makeCtx({ bearer: 'token-a' }))

    try {
      const tabs = await caller.agentBrowser.listTabs({ opencodeSessionId: 'oc-1' })
      expect(tabs).toEqual([
        {
          browserTabId: 'tab-sb-a',
          url: 'https://example.com',
          title: 'oc-1',
          active: true,
          connected: false,
          connectedByCurrentAgent: false,
        },
      ])
    } finally {
      restore()
    }
  })

  it('returns unavailable when no desktop browser bridge is configured', async () => {
    const prevSocket = process.env.CC_DESKTOP_BROWSER_SOCKET
    const prevRoot = process.env.CC_INSTANCE_ROOT
    delete process.env.CC_DESKTOP_BROWSER_SOCKET
    delete process.env.CC_INSTANCE_ROOT
    const { createCaller } = await load()
    const caller = createCaller(makeCtx({ cookieSession: true }))

    try {
      await expect(
        caller.agentBrowser.listTabs({ sandboxId: 'sb-a', opencodeSessionId: 'oc-1' }),
      ).rejects.toThrow(/browser tools unavailable in this environment/i)
    } finally {
      if (prevSocket === undefined) delete process.env.CC_DESKTOP_BROWSER_SOCKET
      else process.env.CC_DESKTOP_BROWSER_SOCKET = prevSocket
      if (prevRoot === undefined) delete process.env.CC_INSTANCE_ROOT
      else process.env.CC_INSTANCE_ROOT = prevRoot
    }
  })
})
