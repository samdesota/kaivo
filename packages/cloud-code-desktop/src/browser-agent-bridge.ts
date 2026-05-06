import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { Server } from 'node:net'
import type { WebContents } from 'electron'
import type { WebframeApp } from '@samdesota/webframe'
import { BrowserAgentConnectionRegistry, type BrowserAgentScope } from './browser-agent-registry'
import { AGENT_TREE_SOURCE, serializeSnapshot, snapshotToText } from './agent-tree-snapshot'

type BridgeRequest = {
  id?: string
  method?: string
  params?: Record<string, unknown>
}

type TabRecord = { id: string; url?: string; title?: string; active?: boolean }

type BrowserConnection = {
  cdpId: string
  browserTabId: string
  url: string
  title: string
  connectedAt: string
}

type BrowserTabSummary = {
  browserTabId: string
  url: string
  title: string
  active: boolean
  connected: boolean
  connectedByCurrentAgent: boolean
}

type SnapshotOutput = {
  url: string
  title: string
  interactiveCount: number
  durationMs: number
  text: string
}

export type BrowserAgentBridgeOptions = {
  socketPath: string
  getWebframeApp: () => WebframeApp | undefined
  findTabWebContents: (browserTabId: string) => WebContents | null
  log?: (message: string, ctx?: Record<string, unknown>) => void
}

export type BrowserAgentBridge = {
  socketPath: string
  registry: BrowserAgentConnectionRegistry
  close: () => Promise<void>
  connectedTabs: () => string[]
  disconnectTab: (browserTabId: string) => void
}

export async function startBrowserAgentBridge(options: BrowserAgentBridgeOptions): Promise<BrowserAgentBridge> {
  fs.mkdirSync(path.dirname(options.socketPath), { recursive: true })
  if (fs.existsSync(options.socketPath)) fs.unlinkSync(options.socketPath)
  const registry = new BrowserAgentConnectionRegistry()
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) void handleLine(line, socket, options, registry)
        index = buffer.indexOf('\n')
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  fs.chmodSync(options.socketPath, 0o600)
  options.log?.('browser agent bridge listening', { socketPath: options.socketPath })

  return {
    socketPath: options.socketPath,
    registry,
    connectedTabs: () => Array.from(new Set((awaitMaybeTabs(registry)))),
    disconnectTab: (browserTabId: string) => {
      const removed = registry.disconnectTab(browserTabId)
      if (removed.length) {
        const contents = options.findTabWebContents(browserTabId)
        if (contents?.debugger.isAttached()) contents.debugger.detach()
      }
    },
    close: () => closeServer(server, options.socketPath),
  }
}

function awaitMaybeTabs(registry: BrowserAgentConnectionRegistry): string[] {
  return registry.connectedBrowserTabIds()
}

async function handleLine(
  line: string,
  socket: net.Socket,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
): Promise<void> {
  let request: BridgeRequest
  try {
    request = JSON.parse(line) as BridgeRequest
    if (!request.id || !request.method) throw new Error('invalid bridge request')
    const result = await dispatch(request.method, request.params ?? {}, options, registry)
    socket.write(`${JSON.stringify({ id: request.id, result })}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const id = requestIdFromLine(line)
    socket.write(`${JSON.stringify({ id, error: { message } })}\n`)
  }
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
): Promise<unknown> {
  const scope = parseScope(params)
  if (method === 'listTabs') return listTabs(scope, options, registry)
  if (method === 'connectTab') return connectTab(scope, String(params.browserTabId ?? ''), options, registry)
  if (method === 'openAndConnect') return openAndConnect(scope, params, options, registry)
  if (method === 'disconnect') return disconnect(scope, String(params.cdpId ?? ''), options, registry)
  if (method === 'snapshot') return snapshot(scope, params, options, registry)
  if (method === 'interact') return interact(scope, params, options, registry)
  if (method === 'screenshot') return screenshot(scope, params, options, registry)
  if (method === 'executeJs') return executeJs(scope, params, options, registry)
  throw new Error(`unsupported browser bridge method: ${method}`)
}

async function listTabs(
  scope: BrowserAgentScope,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
): Promise<BrowserTabSummary[]> {
  const tabs = await getTabs(options)
  return tabs.map((tab) => ({
    browserTabId: tab.id,
    url: tab.url ?? 'about:blank',
    title: tab.title ?? '',
    active: Boolean(tab.active),
    connected: registry.isConnected(tab.id),
    connectedByCurrentAgent: registry.isConnectedBy(scope, tab.id),
  }))
}

async function connectTab(
  scope: BrowserAgentScope,
  browserTabId: string,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
): Promise<BrowserConnection> {
  if (!browserTabId) throw new Error('browserTabId is required')
  const contents = options.findTabWebContents(browserTabId)
  if (!contents || contents.isDestroyed()) throw new Error('browser tab closed')
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
  contents.once('destroyed', () => registry.disconnectTab(browserTabId))
  contents.debugger.once('detach', () => registry.disconnectTab(browserTabId))
  const connection = registry.connect(scope, browserTabId)
  const tab = (await getTabs(options)).find((candidate) => candidate.id === browserTabId)
  return {
    cdpId: connection.cdpId,
    browserTabId,
    url: tab?.url ?? contents.getURL() ?? 'about:blank',
    title: tab?.title ?? contents.getTitle() ?? '',
    connectedAt: connection.connectedAt,
  }
}

async function openAndConnect(
  scope: BrowserAgentScope,
  params: Record<string, unknown>,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
): Promise<BrowserConnection> {
  void scope
  void params
  void options
  void registry
  throw new Error('openAndConnect must be routed through the app UI open-pane flow')
}

async function disconnect(
  scope: BrowserAgentScope,
  cdpId: string,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
): Promise<{ ok: true }> {
  if (!cdpId) throw new Error('cdpId is required')
  const connection = registry.disconnect(scope, cdpId)
  if (!connection) throw new Error('browser connection not found')
  const stillConnected = registry.isConnected(connection.browserTabId)
  const contents = options.findTabWebContents(connection.browserTabId)
  if (!stillConnected && contents?.debugger.isAttached()) contents.debugger.detach()
  return { ok: true }
}

async function snapshot(
  scope: BrowserAgentScope,
  params: Record<string, unknown>,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
): Promise<SnapshotOutput> {
  const cdpId = String(params.cdpId ?? '')
  const connection = registry.get(scope, cdpId)
  if (!connection) throw new Error('browser connection not found')
  const contents = options.findTabWebContents(connection.browserTabId)
  if (!contents || contents.isDestroyed()) {
    registry.disconnectTab(connection.browserTabId)
    throw new Error('browser tab closed')
  }
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
  await ensureAgentTree(contents)
  const rawJson = await evaluateExpression(
    contents,
    `JSON.stringify(window.__agentBrowser.snapshot(${JSON.stringify({ viewportOnly: params.viewportOnly ?? true })}))`,
  )
  const parsed = JSON.parse(String(rawJson))
  const pageSnapshot = serializeSnapshot(parsed, {
    filter: typeof params.filter === 'string' ? params.filter : undefined,
    filterFlags: typeof params.filterFlags === 'string' ? params.filterFlags : undefined,
  })
  return {
    url: pageSnapshot.url,
    title: pageSnapshot.title,
    interactiveCount: pageSnapshot.interactiveCount,
    durationMs: pageSnapshot.durationMs,
    text: snapshotToText(pageSnapshot),
  }
}

async function interact(
  scope: BrowserAgentScope,
  params: Record<string, unknown>,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
): Promise<Record<string, unknown>> {
  const { contents, connection } = connectedContents(scope, String(params.cdpId ?? ''), options, registry)
  await ensureAgentTree(contents)
  const action = params.action as { type?: string; [key: string]: unknown }
  const result = await executeAction(contents, action)
  let postSnapshot: SnapshotOutput | undefined
  if (params.postSnapshot && typeof params.postSnapshot === 'object') {
    const post = params.postSnapshot as Record<string, unknown>
    if (post.wait === 'load' || post.wait === 'settle') await wait(Math.min(Number(post.waitMs ?? 500), 5000))
    postSnapshot = await snapshot(scope, { ...post, cdpId: connection.cdpId }, options, registry)
  }
  return {
    ok: true,
    action,
    url: contents.getURL(),
    title: contents.getTitle(),
    result,
    snapshot: postSnapshot,
  }
}

async function executeAction(contents: WebContents, action: { type?: string; [key: string]: unknown }): Promise<unknown> {
  if (action.type === 'click') {
    return await evaluateExpression(contents, `window.__agentBrowser.click(${JSON.stringify(normalizeElementId(String(action.elementId)))})`)
  }
  if (action.type === 'type') {
    return await evaluateExpression(contents, `window.__agentBrowser.type(${JSON.stringify(normalizeElementId(String(action.elementId)))}, ${JSON.stringify(String(action.text ?? ''))}, ${JSON.stringify({ clear: action.clear })})`)
  }
  if (action.type === 'fill') {
    let result: unknown = { ok: true }
    for (const field of (Array.isArray(action.fields) ? action.fields : []) as Array<Record<string, unknown>>) {
      result = await evaluateExpression(contents, `window.__agentBrowser.type(${JSON.stringify(normalizeElementId(String(field.elementId)))}, ${JSON.stringify(String(field.text ?? ''))}, ${JSON.stringify({ clear: field.clear })})`)
    }
    return result
  }
  if (action.type === 'scroll') {
    return await evaluateExpression(contents, `window.scrollBy(${Number(action.x ?? 0)}, ${Number(action.y ?? 0)}); ({ ok: true })`)
  }
  if (action.type === 'goto') {
    await contents.debugger.sendCommand('Page.navigate', { url: String(action.url) })
    await wait(500)
    await ensureAgentTree(contents)
    return { ok: true, navigated: action.url }
  }
  if (action.type === 'back') {
    await evaluateExpression(contents, 'history.back(); ({ ok: true })')
    await wait(500)
    await ensureAgentTree(contents)
    return { ok: true }
  }
  if (action.type === 'forward') {
    await evaluateExpression(contents, 'history.forward(); ({ ok: true })')
    await wait(500)
    await ensureAgentTree(contents)
    return { ok: true }
  }
  if (action.type === 'wait') {
    const waited = Math.min(Number(action.ms ?? 500), 5000)
    await wait(waited)
    return { ok: true, waited }
  }
  throw new Error('invalid action')
}

async function screenshot(
  scope: BrowserAgentScope,
  params: Record<string, unknown>,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
): Promise<Record<string, unknown>> {
  const { contents } = connectedContents(scope, String(params.cdpId ?? ''), options, registry)
  const format = params.format === 'png' ? 'png' : 'jpeg'
  const result = await contents.debugger.sendCommand('Page.captureScreenshot', {
    format,
    quality: format === 'jpeg' ? Number(params.quality ?? 70) : undefined,
    captureBeyondViewport: Boolean(params.fullPage),
  }) as { data: string }
  const owner = (contents as WebContents & { getOwnerBrowserWindow?: () => { getBounds: () => { width: number; height: number } } | null }).getOwnerBrowserWindow?.()
  const image = owner?.getBounds() ?? { width: 1, height: 1 }
  return {
    format,
    width: image.width,
    height: image.height,
    base64: result.data,
    byteLength: Buffer.byteLength(result.data, 'base64'),
  }
}

async function executeJs(
  scope: BrowserAgentScope,
  params: Record<string, unknown>,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
): Promise<Record<string, unknown>> {
  const { contents } = connectedContents(scope, String(params.cdpId ?? ''), options, registry)
  try {
    const result = await contents.debugger.sendCommand('Runtime.evaluate', {
      expression: String(params.expression ?? ''),
      awaitPromise: params.awaitPromise !== false,
      returnByValue: true,
      timeout: Number(params.timeoutMs ?? 5000),
    }) as { result?: { type?: string; value?: unknown; unserializableValue?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
    return {
      type: result.result?.type ?? 'undefined',
      value: result.result?.value,
      unserializableValue: result.result?.unserializableValue,
      exception: result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text,
    }
  } catch (error) {
    return { type: 'error', exception: error instanceof Error ? error.message : String(error) }
  }
}

function connectedContents(
  scope: BrowserAgentScope,
  cdpId: string,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
): { contents: WebContents; connection: { cdpId: string; browserTabId: string } } {
  const connection = registry.get(scope, cdpId)
  if (!connection) throw new Error('browser connection not found')
  const contents = options.findTabWebContents(connection.browserTabId)
  if (!contents || contents.isDestroyed()) {
    registry.disconnectTab(connection.browserTabId)
    throw new Error('browser tab closed')
  }
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3')
  return { contents, connection }
}

function normalizeElementId(id: string): string {
  return /^\d+$/.test(id) ? `e${id}` : id
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureAgentTree(contents: WebContents): Promise<void> {
  const hasApi = await evaluateExpression(contents, 'Boolean(window.__agentBrowser)')
  if (!hasApi) await evaluateExpression(contents, AGENT_TREE_SOURCE)
}

async function evaluateExpression(contents: WebContents, expression: string): Promise<unknown> {
  const result = await contents.debugger.sendCommand('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }) as { result?: { value?: unknown; unserializableValue?: string }; exceptionDetails?: { text?: string } }
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? 'browser evaluation failed')
  return result.result?.value ?? result.result?.unserializableValue
}

async function getTabs(options: BrowserAgentBridgeOptions): Promise<TabRecord[]> {
  const app = requireWebframe(options)
  return await app.caller.tabs.list() as TabRecord[]
}

function requireWebframe(options: BrowserAgentBridgeOptions): WebframeApp {
  const app = options.getWebframeApp()
  if (!app) throw new Error('browser tools unavailable in this environment')
  return app
}

function parseScope(params: Record<string, unknown>): BrowserAgentScope {
  const opencodeSessionId = String(params.opencodeSessionId ?? '')
  if (!opencodeSessionId) throw new Error('opencodeSessionId is required')
  const sandboxId = typeof params.sandboxId === 'string' && params.sandboxId ? params.sandboxId : null
  return { sandboxId, opencodeSessionId }
}

function requestIdFromLine(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { id?: unknown }
    return typeof parsed.id === 'string' ? parsed.id : null
  } catch {
    return null
  }
}

function closeServer(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      fs.rmSync(socketPath, { force: true })
      resolve()
    })
  })
}
