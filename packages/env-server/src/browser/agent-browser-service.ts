import { TRPCError } from '@trpc/server'
import { desktopBrowserSocketService } from './desktop-browser-socket-client.js'
import type {
  BrowserConnection,
  BrowserTabSummary,
  ExecuteJsOutput,
  InteractOutput,
  ReadLogsOutput,
  ScreenshotOutput,
  SnapshotOutput,
} from '../trpc/routers/agent-browser-schema.js'

export type AgentBrowserScope = {
  sandboxId: string | null
  opencodeSessionId: string
}

export interface AgentBrowserService {
  listTabs(scope: AgentBrowserScope): Promise<BrowserTabSummary[]>
  connectTab(scope: AgentBrowserScope, input: { browserTabId: string }): Promise<BrowserConnection>
  openAndConnect(scope: AgentBrowserScope, input: { url: string; title?: string; activate?: boolean }): Promise<BrowserConnection>
  disconnect(scope: AgentBrowserScope, input: { cdpId: string }): Promise<{ ok: true }>
  snapshot(scope: AgentBrowserScope, input: { cdpId: string; filter?: string; filterFlags?: string; viewportOnly?: boolean }): Promise<SnapshotOutput>
  interact(scope: AgentBrowserScope, input: { cdpId: string; action: unknown; postSnapshot?: unknown }): Promise<InteractOutput>
  screenshot(scope: AgentBrowserScope, input: { cdpId: string }): Promise<ScreenshotOutput>
  executeJs(scope: AgentBrowserScope, input: { cdpId: string; expression: string }): Promise<ExecuteJsOutput>
  readLogs(scope: AgentBrowserScope, input: { cdpId: string; maxEntries?: number }): Promise<ReadLogsOutput>
}

function unavailable(): never {
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: 'browser tools unavailable in this environment',
  })
}

export const unavailableAgentBrowserService: AgentBrowserService = {
  async listTabs() {
    unavailable()
  },
  async connectTab() {
    unavailable()
  },
  async openAndConnect() {
    unavailable()
  },
  async disconnect() {
    unavailable()
  },
  async snapshot() {
    unavailable()
  },
  async interact() {
    unavailable()
  },
  async screenshot() {
    unavailable()
  },
  async executeJs() {
    unavailable()
  },
  async readLogs() {
    unavailable()
  },
}

let agentBrowserService: AgentBrowserService = desktopBrowserSocketService

export function getAgentBrowserService(): AgentBrowserService {
  return agentBrowserService
}

export function setAgentBrowserServiceForTests(service: AgentBrowserService): () => void {
  const prev = agentBrowserService
  agentBrowserService = service
  return () => {
    agentBrowserService = prev
  }
}
