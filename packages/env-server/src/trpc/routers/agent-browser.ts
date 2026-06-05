import { agentShellProcedure, router } from '../trpc.js'
import { TRPCError } from '@trpc/server'
import { getAgentBrowserService } from '../../browser/agent-browser-service.js'
import { openPaneForAgent } from './agent-ui.js'
import { db } from '../../db/client.js'
import { agentSessions } from '../../db/schema.js'
import { eq } from 'drizzle-orm'
import { listWorkspaceBrowserTabs } from '../../identity/client.js'
import { agentService } from '../../agent/service.js'
import {
  cdpConnectionInputSchema,
  connectTabInputSchema,
  executeJsInputSchema,
  interactInputSchema,
  listTabsInputSchema,
  openAndConnectInputSchema,
  readLogsInputSchema,
  screenshotInputSchema,
  snapshotInputSchema,
} from './agent-browser-schema.js'

async function scope(input: { sandboxId?: string; opencodeSessionId: string }) {
  const rootOpencodeSessionId = agentService.resolveRootOpencodeSessionId(input.opencodeSessionId)
  const row = db
    .select({ workspaceId: agentSessions.workspaceId })
    .from(agentSessions)
    .where(eq(agentSessions.opencodeSessionId, rootOpencodeSessionId))
    .limit(1)
    .all()[0]
  const workspaceId = row?.workspaceId ?? null
  const rootBrowserTabIds = workspaceId
    ? (await listWorkspaceBrowserTabs(workspaceId)).map((tab) => tab.browserTabId)
    : []
  return {
    sandboxId: input.sandboxId ?? null,
    opencodeSessionId: rootOpencodeSessionId,
    workspaceId,
    rootBrowserTabIds,
  }
}

export const agentBrowserRouter = router({
  listTabs: agentShellProcedure.input(listTabsInputSchema).query(async ({ input }) => {
    return getAgentBrowserService().listTabs(await scope(input))
  }),

  connectTab: agentShellProcedure.input(connectTabInputSchema).mutation(async ({ input }) => {
    const browserScope = await scope(input)
    const visibleTabs = await getAgentBrowserService().listTabs(browserScope)
    if (!visibleTabs.some((tab) => tab.browserTabId === input.browserTabId || tab.childTabs?.some((child) => child.browserTabId === input.browserTabId))) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'browser tab is not in the current workspace' })
    }
    return getAgentBrowserService().connectTab(browserScope, { browserTabId: input.browserTabId })
  }),

  openAndConnect: agentShellProcedure.input(openAndConnectInputSchema).mutation(async ({ input }) => {
    return openNativeTabAndMirrorPane(input)
  }),

  disconnect: agentShellProcedure.input(cdpConnectionInputSchema).mutation(async ({ input }) => {
    return getAgentBrowserService().disconnect(await scope(input), { cdpId: input.cdpId })
  }),

  snapshot: agentShellProcedure.input(snapshotInputSchema).query(async ({ input }) => {
    return getAgentBrowserService().snapshot(await scope(input), {
      cdpId: input.cdpId,
      filter: input.filter,
      filterFlags: input.filterFlags,
      viewportOnly: input.viewportOnly,
    })
  }),

  interact: agentShellProcedure.input(interactInputSchema).mutation(async ({ input }) => {
    return getAgentBrowserService().interact(await scope(input), {
      cdpId: input.cdpId,
      action: input.action,
      postSnapshot: input.postSnapshot,
    })
  }),

  screenshot: agentShellProcedure.input(screenshotInputSchema).query(async ({ input }) => {
    return getAgentBrowserService().screenshot(await scope(input), { cdpId: input.cdpId })
  }),

  executeJs: agentShellProcedure.input(executeJsInputSchema).mutation(async ({ input }) => {
    return getAgentBrowserService().executeJs(await scope(input), {
      cdpId: input.cdpId,
      expression: input.expression,
    })
  }),

  readLogs: agentShellProcedure.input(readLogsInputSchema).query(async ({ input }) => {
    return getAgentBrowserService().readLogs(await scope(input), {
      cdpId: input.cdpId,
      maxEntries: input.maxEntries,
    })
  }),
})

async function openNativeTabAndMirrorPane(
  input: { sandboxId?: string; opencodeSessionId: string; url: string; title?: string; activate?: boolean },
) {
  const service = getAgentBrowserService()
  const connection = await service.openAndConnect(await scope(input), {
    url: input.url,
    title: input.title,
    activate: input.activate,
  })
  await openPaneForAgent({
    opencodeSessionId: input.opencodeSessionId,
    content: { type: 'browser', url: input.url, browserTabId: connection.browserTabId },
    title: input.title,
    activate: input.activate,
  })
  return connection
}
