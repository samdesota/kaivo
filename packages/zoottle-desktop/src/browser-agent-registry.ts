import { randomUUID } from 'node:crypto'

export type BrowserAgentScope = {
  sandboxId: string | null
  opencodeSessionId: string
}

export type BrowserAgentConnection = BrowserAgentScope & {
  cdpId: string
  browserTabId: string
  connectedAt: string
}

export class BrowserAgentConnectionRegistry {
  private readonly byCdpId = new Map<string, BrowserAgentConnection>()
  private readonly byBrowserTabId = new Map<string, Set<string>>()

  connect(scope: BrowserAgentScope, browserTabId: string): BrowserAgentConnection {
    const connection: BrowserAgentConnection = {
      ...scope,
      cdpId: randomUUID(),
      browserTabId,
      connectedAt: new Date().toISOString(),
    }
    this.byCdpId.set(connection.cdpId, connection)
    let tabConnections = this.byBrowserTabId.get(browserTabId)
    if (!tabConnections) {
      tabConnections = new Set()
      this.byBrowserTabId.set(browserTabId, tabConnections)
    }
    tabConnections.add(connection.cdpId)
    return connection
  }

  get(scope: BrowserAgentScope, cdpId: string): BrowserAgentConnection | null {
    const connection = this.byCdpId.get(cdpId)
    if (!connection) return null
    if (connection.opencodeSessionId !== scope.opencodeSessionId) return null
    if (connection.sandboxId !== scope.sandboxId) return null
    return connection
  }

  disconnect(scope: BrowserAgentScope, cdpId: string): BrowserAgentConnection | null {
    const connection = this.get(scope, cdpId)
    if (!connection) return null
    this.remove(connection)
    return connection
  }

  disconnectTab(browserTabId: string): BrowserAgentConnection[] {
    const ids = Array.from(this.byBrowserTabId.get(browserTabId) ?? [])
    const removed: BrowserAgentConnection[] = []
    for (const id of ids) {
      const connection = this.byCdpId.get(id)
      if (!connection) continue
      this.remove(connection)
      removed.push(connection)
    }
    return removed
  }

  listForTab(browserTabId: string): BrowserAgentConnection[] {
    return Array.from(this.byBrowserTabId.get(browserTabId) ?? [])
      .map((id) => this.byCdpId.get(id))
      .filter((connection): connection is BrowserAgentConnection => Boolean(connection))
  }

  isConnected(browserTabId: string): boolean {
    return this.listForTab(browserTabId).length > 0
  }

  connectedBrowserTabIds(): string[] {
    return Array.from(this.byBrowserTabId.keys())
  }

  isConnectedBy(scope: BrowserAgentScope, browserTabId: string): boolean {
    return this.listForTab(browserTabId).some(
      (connection) => connection.opencodeSessionId === scope.opencodeSessionId && connection.sandboxId === scope.sandboxId,
    )
  }

  private remove(connection: BrowserAgentConnection): void {
    this.byCdpId.delete(connection.cdpId)
    const tabConnections = this.byBrowserTabId.get(connection.browserTabId)
    tabConnections?.delete(connection.cdpId)
    if (tabConnections?.size === 0) this.byBrowserTabId.delete(connection.browserTabId)
  }
}
