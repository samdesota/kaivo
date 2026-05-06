import { router } from '../trpc.js'
import { agentShellProcedure, resolveAgentSandboxId } from '../middleware/agent-shell-auth.js'
import { getAgentBrowserService } from '../../browser/agent-browser-service.js'
import { openPaneForAgent } from './agent-ui.js'
import {
  cdpConnectionInputSchema,
  connectTabInputSchema,
  executeJsInputSchema,
  interactInputSchema,
  listTabsInputSchema,
  openAndConnectInputSchema,
  screenshotInputSchema,
  snapshotInputSchema,
} from './agent-browser-schema.js'

function scope(ctx: { agentSandboxId: string | null; agentAuthKind: 'token' | 'cookie' }, input: { sandboxId?: string; opencodeSessionId: string }) {
  return {
    sandboxId: resolveAgentSandboxId(ctx, input.sandboxId),
    opencodeSessionId: input.opencodeSessionId,
  }
}

export const agentBrowserRouter = router({
  listTabs: agentShellProcedure.input(listTabsInputSchema).query(({ ctx, input }) => {
    return getAgentBrowserService().listTabs(scope(ctx, input))
  }),

  connectTab: agentShellProcedure.input(connectTabInputSchema).mutation(({ ctx, input }) => {
    return getAgentBrowserService().connectTab(scope(ctx, input), { browserTabId: input.browserTabId })
  }),

  openAndConnect: agentShellProcedure.input(openAndConnectInputSchema).mutation(({ ctx, input }) => {
    const browserScope = scope(ctx, input)
    return openNormalPaneAndConnect(browserScope, input)
  }),

  disconnect: agentShellProcedure.input(cdpConnectionInputSchema).mutation(({ ctx, input }) => {
    return getAgentBrowserService().disconnect(scope(ctx, input), { cdpId: input.cdpId })
  }),

  snapshot: agentShellProcedure.input(snapshotInputSchema).query(({ ctx, input }) => {
    return getAgentBrowserService().snapshot(scope(ctx, input), {
      cdpId: input.cdpId,
      filter: input.filter,
      filterFlags: input.filterFlags,
      viewportOnly: input.viewportOnly,
    })
  }),

  interact: agentShellProcedure.input(interactInputSchema).mutation(({ ctx, input }) => {
    return getAgentBrowserService().interact(scope(ctx, input), {
      cdpId: input.cdpId,
      action: input.action,
      postSnapshot: input.postSnapshot,
    })
  }),

  screenshot: agentShellProcedure.input(screenshotInputSchema).query(({ ctx, input }) => {
    return getAgentBrowserService().screenshot(scope(ctx, input), { cdpId: input.cdpId })
  }),

  executeJs: agentShellProcedure.input(executeJsInputSchema).mutation(({ ctx, input }) => {
    return getAgentBrowserService().executeJs(scope(ctx, input), {
      cdpId: input.cdpId,
      expression: input.expression,
    })
  }),
})

async function openNormalPaneAndConnect(
  browserScope: { sandboxId: string; opencodeSessionId: string },
  input: { opencodeSessionId: string; url: string; title?: string; activate?: boolean },
) {
  const service = getAgentBrowserService()
  const before = new Set((await service.listTabs(browserScope)).map((tab) => tab.browserTabId))
  await openPaneForAgent({
    sandboxId: browserScope.sandboxId,
    opencodeSessionId: input.opencodeSessionId,
    content: { type: 'browser', url: input.url },
    title: input.title,
    activate: input.activate,
  })
  const tab = await waitForOpenedTab(() => service.listTabs(browserScope), before, input.url)
  return service.connectTab(browserScope, { browserTabId: tab.browserTabId })
}

async function waitForOpenedTab(
  listTabs: () => Promise<Array<{ browserTabId: string; url: string }>>,
  before: Set<string>,
  url: string,
) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const tabs = await listTabs()
    const tab = tabs.find((candidate) => !before.has(candidate.browserTabId) && candidate.url === url)
      ?? tabs.find((candidate) => !before.has(candidate.browserTabId) && normalizeComparableUrl(candidate.url) === normalizeComparableUrl(url))
    if (tab) return tab
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error('browser tab did not open')
}

function normalizeComparableUrl(value: string): string {
  return value.replace(/\/+$/, '')
}
