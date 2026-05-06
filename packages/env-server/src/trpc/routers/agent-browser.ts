import { agentShellProcedure, router } from '../trpc.js'
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

function scope(input: { sandboxId?: string; opencodeSessionId: string }) {
  return {
    sandboxId: input.sandboxId ?? null,
    opencodeSessionId: input.opencodeSessionId,
  }
}

export const agentBrowserRouter = router({
  listTabs: agentShellProcedure.input(listTabsInputSchema).query(({ input }) => {
    return getAgentBrowserService().listTabs(scope(input))
  }),

  connectTab: agentShellProcedure.input(connectTabInputSchema).mutation(({ input }) => {
    return getAgentBrowserService().connectTab(scope(input), { browserTabId: input.browserTabId })
  }),

  openAndConnect: agentShellProcedure.input(openAndConnectInputSchema).mutation(({ input }) => {
    const browserScope = scope(input)
    return openNormalPaneAndConnect(browserScope, input)
  }),

  disconnect: agentShellProcedure.input(cdpConnectionInputSchema).mutation(({ input }) => {
    return getAgentBrowserService().disconnect(scope(input), { cdpId: input.cdpId })
  }),

  snapshot: agentShellProcedure.input(snapshotInputSchema).query(({ input }) => {
    return getAgentBrowserService().snapshot(scope(input), {
      cdpId: input.cdpId,
      filter: input.filter,
      filterFlags: input.filterFlags,
      viewportOnly: input.viewportOnly,
    })
  }),

  interact: agentShellProcedure.input(interactInputSchema).mutation(({ input }) => {
    return getAgentBrowserService().interact(scope(input), {
      cdpId: input.cdpId,
      action: input.action,
      postSnapshot: input.postSnapshot,
    })
  }),

  screenshot: agentShellProcedure.input(screenshotInputSchema).query(({ input }) => {
    return getAgentBrowserService().screenshot(scope(input), { cdpId: input.cdpId })
  }),

  executeJs: agentShellProcedure.input(executeJsInputSchema).mutation(({ input }) => {
    return getAgentBrowserService().executeJs(scope(input), {
      cdpId: input.cdpId,
      expression: input.expression,
    })
  }),
})

async function openNormalPaneAndConnect(
  browserScope: { sandboxId: string | null; opencodeSessionId: string },
  input: { opencodeSessionId: string; url: string; title?: string; activate?: boolean },
) {
  const service = getAgentBrowserService()
  const before = new Set((await service.listTabs(browserScope)).map((tab) => tab.browserTabId))
  openPaneForAgent({
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
