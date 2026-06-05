import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { Server } from 'node:net'
import type { Event as ElectronEvent, WebContents } from 'electron'
import type { WebframeApp } from '@samdesota/webframe'
import { BrowserAgentConnectionRegistry, type BrowserAgentScope } from './browser-agent-registry'
import { AGENT_TREE_SOURCE, serializeSnapshot, snapshotToText } from './agent-tree-snapshot'

type BridgeRequest = {
  id?: string
  method?: string
  params?: Record<string, unknown>
}

type TabRecord = { id: string; url?: string; title?: string; favicon?: string; active?: boolean; presentation?: 'embedded' | 'popup'; openerTabId?: string }

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
  favicon?: string
  active: boolean
  connected: boolean
  connectedByCurrentAgent: boolean
  presentation?: 'embedded' | 'popup'
  openerBrowserTabId?: string | null
  childTabs?: BrowserChildTabSummary[]
}

type BrowserChildTabSummary = {
  browserTabId: string
  url: string
  title: string
  favicon?: string
  active: boolean
  connected: boolean
  connectedByCurrentAgent: boolean
  presentation?: 'embedded' | 'popup'
  openerBrowserTabId: string
}

type BrowserLogEntry = {
  ts: string
  level: string
  message: string
  line?: number
  sourceId?: string
}

type BrowserLogState = {
  buffers: Map<string, BrowserLogEntry[]>
  disposers: Map<string, () => void>
}

const AGENT_BROWSER_VIEWPORT = { width: 1280, height: 720 }

type SnapshotOutput = {
  url: string
  title: string
  interactiveCount: number
  durationMs: number
  text: string
  childTabs: BrowserChildTabSummary[]
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
  const logs: BrowserLogState = { buffers: new Map(), disposers: new Map() }
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line) void handleLine(line, socket, options, registry, logs)
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
        logs.disposers.get(browserTabId)?.()
        logs.disposers.delete(browserTabId)
        const contents = options.findTabWebContents(browserTabId)
        if (contents?.debugger.isAttached()) contents.debugger.detach()
      }
    },
    close: () => {
      for (const dispose of logs.disposers.values()) dispose()
      logs.disposers.clear()
      return closeServer(server, options.socketPath)
    },
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
  logs: BrowserLogState,
): Promise<void> {
  let request: BridgeRequest
  try {
    request = JSON.parse(line) as BridgeRequest
    if (!request.id || !request.method) throw new Error('invalid bridge request')
    const result = await dispatch(request.method, request.params ?? {}, options, registry, logs)
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
  logs: BrowserLogState,
): Promise<unknown> {
  const scope = parseScope(params)
  if (method === 'listTabs') return listTabs(scope, params, options, registry)
  if (method === 'connectTab') return connectTab(scope, String(params.browserTabId ?? ''), options, registry, logs)
  if (method === 'openAndConnect') return openAndConnect(scope, params, options, registry, logs)
  if (method === 'disconnect') return disconnect(scope, String(params.cdpId ?? ''), options, registry, logs)
  if (method === 'snapshot') return snapshot(scope, params, options, registry)
  if (method === 'interact') return interact(scope, params, options, registry)
  if (method === 'screenshot') return screenshot(scope, params, options, registry)
  if (method === 'executeJs') return executeJs(scope, params, options, registry)
  if (method === 'readLogs') return readLogs(scope, params, options, registry, logs)
  throw new Error(`unsupported browser bridge method: ${method}`)
}

async function listTabs(
  scope: BrowserAgentScope,
  params: Record<string, unknown>,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
): Promise<BrowserTabSummary[]> {
  const tabs = await getTabs(options)
  const rootBrowserTabIds = Array.isArray(params.rootBrowserTabIds)
    ? params.rootBrowserTabIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  const visibleTabs = tabsForRoots(rootBrowserTabIds, tabs)
  return visibleTabs.map((tab) => ({
    browserTabId: tab.id,
    url: tab.url ?? 'about:blank',
    title: tab.title ?? '',
    favicon: tab.favicon,
    active: Boolean(tab.active),
    connected: registry.isConnected(tab.id),
    connectedByCurrentAgent: registry.isConnectedBy(scope, tab.id),
    presentation: tab.presentation,
    openerBrowserTabId: tab.openerTabId ?? null,
    childTabs: childTabsFor(tab.id, tabs, scope, registry),
  }))
}

async function connectTab(
  scope: BrowserAgentScope,
  browserTabId: string,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
  logs: BrowserLogState,
): Promise<BrowserConnection> {
  if (!browserTabId) throw new Error('browserTabId is required')
  const contents = options.findTabWebContents(browserTabId)
  if (!contents || contents.isDestroyed()) throw new Error('browser tab closed')
  installLogCollector(browserTabId, contents, logs)
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
  logs: BrowserLogState,
): Promise<BrowserConnection> {
  const url = String(params.url ?? '').trim()
  if (!url) throw new Error('url is required')
  const tab = await createTab(options, url)
  await waitForTabWebContents(tab.id, options)
  return connectTab(scope, tab.id, options, registry, logs)
}

async function disconnect(
  scope: BrowserAgentScope,
  cdpId: string,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
  logs: BrowserLogState,
): Promise<{ ok: true }> {
  if (!cdpId) throw new Error('cdpId is required')
  const connection = registry.disconnect(scope, cdpId)
  if (!connection) throw new Error('browser connection not found')
  const stillConnected = registry.isConnected(connection.browserTabId)
  const contents = options.findTabWebContents(connection.browserTabId)
  if (!stillConnected && contents?.debugger.isAttached()) contents.debugger.detach()
  if (!stillConnected) {
    logs.disposers.get(connection.browserTabId)?.()
    logs.disposers.delete(connection.browserTabId)
  }
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
    childTabs: childTabsFor(connection.browserTabId, await getTabs(options), scope, registry),
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
    return await dispatchMouseClick(contents, normalizeElementId(String(action.elementId)))
  }
  if (action.type === 'type') {
    return await dispatchTextInput(contents, normalizeElementId(String(action.elementId)), String(action.text ?? ''), { clear: action.clear !== false })
  }
  if (action.type === 'fill') {
    let result: unknown = { ok: true }
    for (const field of (Array.isArray(action.fields) ? action.fields : []) as Array<Record<string, unknown>>) {
      result = await dispatchTextInput(contents, normalizeElementId(String(field.elementId)), String(field.text ?? ''), { clear: field.clear !== false })
    }
    return result
  }
  if (action.type === 'scroll') {
    return await dispatchWheel(contents, Number(action.x ?? 0), Number(action.y ?? 0))
  }
  if (action.type === 'goto') {
    await contents.debugger.sendCommand('Page.navigate', { url: String(action.url) })
    await wait(500)
    await ensureAgentTree(contents)
    return { ok: true, navigated: action.url }
  }
  if (action.type === 'back') {
    const navigated = await navigateHistory(contents, -1)
    await wait(500)
    await ensureAgentTree(contents)
    return navigated
  }
  if (action.type === 'forward') {
    const navigated = await navigateHistory(contents, 1)
    await wait(500)
    await ensureAgentTree(contents)
    return navigated
  }
  if (action.type === 'wait') {
    const waited = Math.min(Number(action.ms ?? 500), 5000)
    await wait(waited)
    return { ok: true, waited }
  }
  throw new Error('invalid action')
}

async function dispatchMouseClick(contents: WebContents, elementId: string): Promise<Record<string, unknown>> {
  const { x, y, width, height } = await elementCenter(contents, elementId)
  await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  return { ok: true, x, y, width, height }
}

async function dispatchTextInput(
  contents: WebContents,
  elementId: string,
  text: string,
  options: { clear: boolean },
): Promise<Record<string, unknown>> {
  const elementInfo = await evaluateExpression(
    contents,
    `(() => {
      const element = window.__agentBrowser.element(${JSON.stringify(elementId)});
      return {
        tagName: element.tagName,
        targetValue: element.tagName === 'SELECT'
          ? Array.from(element.options).find((option) => option.value === ${JSON.stringify(text)} || option.textContent.trim() === ${JSON.stringify(text)})?.value
          : undefined,
        selectIndex: element.tagName === 'SELECT'
          ? Array.from(element.options).findIndex((option) => option.value === ${JSON.stringify(text)} || option.textContent.trim() === ${JSON.stringify(text)})
          : -1,
      };
    })()`,
  ) as { tagName?: unknown; selectIndex?: unknown; targetValue?: unknown }
  if (elementInfo.tagName === 'SELECT') {
    return await dispatchSelectInput(contents, elementId, Number(elementInfo.selectIndex), String(elementInfo.targetValue ?? ''))
  }
  await dispatchMouseClick(contents, elementId)
  if (options.clear) {
    await pressShortcut(contents, process.platform === 'darwin' ? 'Meta' : 'Control', 'A')
    await pressKey(contents, 'Backspace')
  }
  if (text) await contents.debugger.sendCommand('Input.insertText', { text })
  return { ok: true, valueLength: text.length }
}

async function dispatchSelectInput(contents: WebContents, elementId: string, selectIndex: number, targetValue: string): Promise<Record<string, unknown>> {
  if (!Number.isInteger(selectIndex) || selectIndex < 0) throw new Error('select option not found')
  await evaluateExpression(
    contents,
    `(() => {
      const element = window.__agentBrowser.element(${JSON.stringify(elementId)});
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.focus();
      return true;
    })()`,
  )
  await pressKey(contents, 'Home')
  for (let i = 0; i < selectIndex; i += 1) await pressKey(contents, 'ArrowDown')
  await pressKey(contents, 'Enter')
  const actualValue = await evaluateExpression(
    contents,
    `window.__agentBrowser.element(${JSON.stringify(elementId)}).value`,
  )
  return { ok: actualValue === targetValue, selectedIndex: selectIndex, value: actualValue }
}

async function dispatchWheel(contents: WebContents, deltaX: number, deltaY: number): Promise<Record<string, unknown>> {
  const viewport = await evaluateExpression(
    contents,
    '({ x: Math.max(1, Math.floor(window.innerWidth / 2)), y: Math.max(1, Math.floor(window.innerHeight / 2)) })',
  ) as { x?: unknown; y?: unknown }
  const x = Number(viewport.x)
  const y = Number(viewport.y)
  await contents.debugger.sendCommand('Input.synthesizeScrollGesture', {
    x: Number.isFinite(x) ? x : 1,
    y: Number.isFinite(y) ? y : 1,
    xDistance: -deltaX,
    yDistance: -deltaY,
    gestureSourceType: 'mouse',
  })
  return { ok: true, deltaX, deltaY }
}

async function navigateHistory(contents: WebContents, offset: -1 | 1): Promise<Record<string, unknown>> {
  const history = await contents.debugger.sendCommand('Page.getNavigationHistory') as {
    currentIndex?: number
    entries?: Array<{ id: number; url?: string }>
  }
  const currentIndex = Number(history.currentIndex ?? -1)
  const entry = history.entries?.[currentIndex + offset]
  if (!entry) return { ok: false, reason: offset < 0 ? 'no back history' : 'no forward history' }
  await contents.debugger.sendCommand('Page.navigateToHistoryEntry', { entryId: entry.id })
  return { ok: true, navigated: entry.url }
}

async function elementCenter(contents: WebContents, elementId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await evaluateExpression(
    contents,
    `(() => {
      const element = window.__agentBrowser.element(${JSON.stringify(elementId)});
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
    })()`,
  ) as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  const x = Number(rect.x)
  const y = Number(rect.y)
  const width = Number(rect.width)
  const height = Number(rect.height)
  if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) throw new Error('element is not clickable')
  return { x, y, width, height }
}

async function pressShortcut(contents: WebContents, modifier: 'Control' | 'Meta', key: string): Promise<void> {
  const modifiers = modifier === 'Meta' ? 4 : 2
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: `Key${key.toUpperCase()}`, modifiers })
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: `Key${key.toUpperCase()}`, modifiers })
}

async function pressKey(contents: WebContents, key: string): Promise<void> {
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key })
  await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key })
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

async function readLogs(
  scope: BrowserAgentScope,
  params: Record<string, unknown>,
  options: BrowserAgentBridgeOptions,
  registry: BrowserAgentConnectionRegistry,
  logs: BrowserLogState,
): Promise<{ entries: BrowserLogEntry[]; truncated: boolean }> {
  const { connection } = connectedContents(scope, String(params.cdpId ?? ''), options, registry)
  const maxEntries = Math.min(Math.max(Number(params.maxEntries ?? 100), 1), 500)
  const entries = logs.buffers.get(connection.browserTabId) ?? []
  return {
    entries: entries.slice(-maxEntries),
    truncated: entries.length > maxEntries,
  }
}

function installLogCollector(browserTabId: string, contents: WebContents, logs: BrowserLogState): void {
  if (logs.disposers.has(browserTabId)) return
  const onConsoleMessage = (_event: ElectronEvent, level: number, message: string, line: number, sourceId: string) => {
    appendLog(logs, browserTabId, {
      ts: new Date().toISOString(),
      level: consoleLevel(level),
      message,
      line,
      sourceId,
    })
  }
  const dispose = () => contents.off('console-message', onConsoleMessage)
  contents.on('console-message', onConsoleMessage)
  contents.once('destroyed', dispose)
  logs.disposers.set(browserTabId, dispose)
  if (!logs.buffers.has(browserTabId)) logs.buffers.set(browserTabId, [])
}

function appendLog(logs: BrowserLogState, browserTabId: string, entry: BrowserLogEntry): void {
  const buffer = logs.buffers.get(browserTabId) ?? []
  buffer.push(entry)
  if (buffer.length > 1000) buffer.splice(0, buffer.length - 1000)
  logs.buffers.set(browserTabId, buffer)
}

function consoleLevel(level: number): string {
  if (level === 0) return 'verbose'
  if (level === 1) return 'info'
  if (level === 2) return 'warning'
  if (level === 3) return 'error'
  return String(level)
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

async function createTab(options: BrowserAgentBridgeOptions, url: string): Promise<TabRecord> {
  const app = requireWebframe(options)
  const windowId = app.windows.list()[0]?.id
  if (!windowId) throw new Error('browser window unavailable')
  return await app.caller.tabs.create({
    url,
    windowId,
    placement: { x: 0, y: 0, w: AGENT_BROWSER_VIEWPORT.width, h: AGENT_BROWSER_VIEWPORT.height },
    active: false,
  }) as TabRecord
}

async function waitForTabWebContents(browserTabId: string, options: BrowserAgentBridgeOptions): Promise<WebContents> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const contents = options.findTabWebContents(browserTabId)
    if (contents && !contents.isDestroyed()) return contents
    await wait(50)
  }
  throw new Error('browser tab did not open')
}

function tabsForRoots(rootBrowserTabIds: string[], tabs: TabRecord[]): TabRecord[] {
  const ids = new Set<string>()
  for (const browserTabId of rootBrowserTabIds) collectDescendantTabIds(browserTabId, tabs, ids)
  return tabs.filter((tab) => ids.has(tab.id))
}

function childTabsFor(
  browserTabId: string,
  tabs: TabRecord[],
  scope: BrowserAgentScope,
  registry: BrowserAgentConnectionRegistry,
): BrowserChildTabSummary[] {
  return tabs
    .filter((tab) => tab.openerTabId === browserTabId)
    .map((tab) => ({
      browserTabId: tab.id,
      url: tab.url ?? 'about:blank',
      title: tab.title ?? '',
      favicon: tab.favicon,
      active: Boolean(tab.active),
      connected: registry.isConnected(tab.id),
      connectedByCurrentAgent: registry.isConnectedBy(scope, tab.id),
      presentation: tab.presentation,
      openerBrowserTabId: browserTabId,
    }))
}

function collectDescendantTabIds(browserTabId: string, tabs: TabRecord[], ids: Set<string>): void {
  if (ids.has(browserTabId)) return
  ids.add(browserTabId)
  for (const tab of tabs) {
    if (tab.openerTabId === browserTabId) collectDescendantTabIds(tab.id, tabs, ids)
  }
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
