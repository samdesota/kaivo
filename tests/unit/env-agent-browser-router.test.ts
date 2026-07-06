import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserService } from '../../packages/env-server/src/browser/agent-browser-service.js'

const openPaneForAgentMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/env-server/src/trpc/routers/agent-ui.js', async () => {
  const actual = await vi.importActual<typeof import('../../packages/env-server/src/trpc/routers/agent-ui.js')>(
    '../../packages/env-server/src/trpc/routers/agent-ui.js',
  )
  return {
    ...actual,
    openPaneForAgent: openPaneForAgentMock,
  }
})

vi.mock('../../packages/env-server/src/envmeta/service.js', () => ({
  hashEnvToken: (token: string) => `hash:${token}`,
  hasEnvTokenHash: () => false,
  isPaired: () => true,
}))

vi.mock('../../packages/env-server/src/agent/opencode.js', () => ({
  opencodeSupervisor: {
    verifyAgentShellToken: (token: string) => token === 'agent-token',
  },
}))

vi.mock('../../packages/env-server/src/db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            all: () => [{ workspaceId: 'ws-1' }],
          }),
        }),
      }),
    }),
  },
}))

vi.mock('../../packages/env-server/src/identity/client.js', () => ({
  listWorkspaceBrowserTabs: async () => [{ browserTabId: 'tab-sb-local' }],
}))

function fakeBrowserService(overrides: Partial<AgentBrowserService> = {}): AgentBrowserService {
  return {
    async listTabs(scope) {
      return [
        {
          browserTabId: `tab-${scope.sandboxId ?? 'local'}`,
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
    async readLogs() {
      throw new Error('unused')
    },
    ...overrides,
  }
}

function makeCtx(token = 'agent-token') {
  return {
    req: { headers: { authorization: `Bearer ${token}` } },
    res: {},
    envTokenPresent: false,
    agentShellTokenPresent: token === 'agent-token',
  } as unknown as import('../../packages/env-server/src/trpc/trpc.js').Context
}

describe('agentBrowser env-server router', () => {
  beforeEach(() => {
    process.env.CC_WORKING_DIR = '/tmp/cloud-code-test-workspace'
    process.env.CC_IDENTITY_URL = 'http://127.0.0.1:3000'
    process.env.CC_STATE_DIR = '/tmp/cloud-code-test-state'
    openPaneForAgentMock.mockReset()
    vi.resetModules()
  })

  it('exposes the mirrored browser procedure names', async () => {
    const { appRouter } = await import('../../packages/env-server/src/trpc/router.js')

    expect(Object.keys(appRouter._def.procedures).filter((name) => name.startsWith('agentBrowser.'))).toEqual([
      'agentBrowser.listTabs',
      'agentBrowser.connectTab',
      'agentBrowser.openAndConnect',
      'agentBrowser.disconnect',
      'agentBrowser.snapshot',
      'agentBrowser.interact',
      'agentBrowser.screenshot',
      'agentBrowser.executeJs',
      'agentBrowser.readLogs',
    ])
  })

  it('uses the same input validation before invoking the browser service', async () => {
    const [{ appRouter }, service] = await Promise.all([
      import('../../packages/env-server/src/trpc/router.js'),
      import('../../packages/env-server/src/browser/agent-browser-service.js'),
    ])
    const restore = service.setAgentBrowserServiceForTests(fakeBrowserService())
    const caller = appRouter.createCaller(makeCtx())

    try {
      await expect(
        caller.agentBrowser.openAndConnect({ opencodeSessionId: 'oc-1', url: 'file:///etc/passwd' }),
      ).rejects.toThrow(/unsafe browser URL/i)
      const tabs = await caller.agentBrowser.listTabs({ sandboxId: 'sb-local', opencodeSessionId: 'oc-1' })
      expect(tabs[0]?.browserTabId).toBe('tab-sb-local')
    } finally {
      restore()
    }
  })

  it('opens through the browser service before mirroring the native tab into workspace state', async () => {
    const [{ appRouter }, service] = await Promise.all([
      import('../../packages/env-server/src/trpc/router.js'),
      import('../../packages/env-server/src/browser/agent-browser-service.js'),
    ])
    const openAndConnect = vi.fn(async () => ({
      cdpId: 'cdp-1',
      browserTabId: 'native-tab-1',
      url: 'https://example.com/app',
      title: 'Native tab',
      connectedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    }))
    const restore = service.setAgentBrowserServiceForTests(fakeBrowserService({ openAndConnect }))
    const caller = appRouter.createCaller(makeCtx())

    try {
      const result = await caller.agentBrowser.openAndConnect({
        sandboxId: 'sb-local',
        opencodeSessionId: 'oc-1',
        url: 'example.com/app',
        title: 'Example app',
        activate: false,
      })

      expect(result.browserTabId).toBe('native-tab-1')
      expect(openAndConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxId: 'sb-local',
          opencodeSessionId: 'oc-1',
          workspaceId: 'ws-1',
          rootBrowserTabIds: ['tab-sb-local'],
        }),
        { url: 'https://example.com/app', title: 'Example app', activate: false },
      )
      expect(openPaneForAgentMock).toHaveBeenCalledWith({
        opencodeSessionId: 'oc-1',
        content: { type: 'browser', url: 'https://example.com/app', browserTabId: 'native-tab-1' },
        title: 'Example app',
        activate: false,
      })
      const openAndConnectCallOrder = openAndConnect.mock.invocationCallOrder[0]
      const openPaneCallOrder = openPaneForAgentMock.mock.invocationCallOrder[0]
      expect(openAndConnectCallOrder).toBeDefined()
      expect(openPaneCallOrder).toBeDefined()
      expect(openAndConnectCallOrder!).toBeLessThan(openPaneCallOrder!)
    } finally {
      restore()
    }
  })
})
