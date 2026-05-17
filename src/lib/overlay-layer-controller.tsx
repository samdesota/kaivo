import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { EnvRef } from './env-client'
import { browserApi } from './browser-api'
import { makeTrpcClient, trpc } from '../trpc'
import { OVERLAY_CHANNEL, OverlayLayerApp, type BrowserUrlPopoverResult, type OverlayRequest, type OverlayResponse } from '../routes/internal/overlay-layer'
import type { PaneContent } from '../routes/env/shell/tab-state'
import type { NewAgentChatSelection, NewAgentChatWorkspaceMode } from '../routes/env/agent/new-agent-chat-state'
import type { WorkspaceResourceRecord } from '../routes/workspace/resources-store'
import type { UniversalMenuContextItem } from '../routes/env/universal-menu/universal-menu'

/**
 * Desktop modals must be opened through this controller so they render in the
 * detached Electron overlay above browser tabs. Add new modal request/response
 * types here and render their UI in routes/internal/overlay-layer.tsx.
 */

type NewAgentChatInput = {
  workspaceId?: string
  workspaceName?: string
  initialWorkspaceMode?: NewAgentChatWorkspaceMode
  initialSelection?: NewAgentChatSelection
  folderId?: string | null
  env: EnvRef & { label: string }
  envToken: string
}

export type NewAgentChatOverlayResult = { sessionId: string; workspaceId?: string }

type EnvOverlayInput = {
  env: EnvRef & { label: string }
  envToken: string
}

export type CommandPaletteOverlayResult =
  | { type: 'open-pane'; content: PaneContent }
  | { type: 'close-tab' }
  | { type: 'new-session' }
  | { type: 'new-workspace' }
  | { type: 'closed' }

export type UniversalMenuOverlayResult =
  | { type: 'open-pane'; content: PaneContent }
  | { type: 'created-agent-chat'; sessionId: string; workspaceId?: string }
  | { type: 'switch-workspace'; workspaceId: string }
  | { type: 'close-tab' }
  | { type: 'toggle-agent-pane' }
  | { type: 'toggle-sidebar' }
  | { type: 'open-settings' }
  | { type: 'closed' }

export type CreateBookmarkOverlayInput = {
  workspaceId: string
  initialTitle?: string
  initialUrl: string
  initialFaviconDataUrl?: string | null
  initialFaviconUrl?: string | null
}

export type BrowserUrlPopoverInput = {
  anchor: { left: number; top: number; width: number }
  results: BrowserUrlPopoverResult[]
  activeIndex: number | null
}

export type BrowserUrlPopoverSession = {
  requestId: string
  update(input: BrowserUrlPopoverInput): void
  close(): void
}

let detachedOverlayId: string | null = null
let readyPromise: Promise<void> | null = null

export function prewarmOverlayLayer(): void {
  if (!browserApi.isAvailable()) return
  void ensureElectronOverlay().catch((e) => {
    console.warn('webframe overlay prewarm failed', e)
  })
}

export async function openNewAgentChatOverlay(input: NewAgentChatInput): Promise<string | null> {
  const result = await openNewAgentChatOverlayDetailed(input)
  return result?.sessionId ?? null
}

export async function openNewAgentChatOverlayDetailed(input: NewAgentChatInput): Promise<NewAgentChatOverlayResult | null> {
  const request: OverlayRequest = {
    requestId: makeOverlayRequestId(),
    type: 'new-agent-chat',
    ...input,
  }

  const response = await openOverlayRequest(request)
  if (response.type === 'created-agent-chat') return { sessionId: response.sessionId, workspaceId: response.workspaceId }
  if (response.type === 'closed') return null
  throw new Error(`unexpected overlay response: ${response.type}`)
}

export async function openFolderPickerOverlay(
  input: EnvOverlayInput & { title?: string; busy?: boolean },
): Promise<string | null> {
  const response = await openOverlayRequest({
    requestId: makeOverlayRequestId(),
    type: 'folder-picker',
    ...input,
  })
  if (response.type === 'selected-folder') return response.path
  if (response.type === 'closed') return null
  throw new Error(`unexpected overlay response: ${response.type}`)
}

export async function openCommandPaletteOverlay(
  input: EnvOverlayInput & {
    workspaceId?: string
    activeSessionId?: string | null
    hasActiveTab: boolean
  },
): Promise<CommandPaletteOverlayResult> {
  const response = await openOverlayRequest({
    requestId: makeOverlayRequestId(),
    type: 'command-palette',
    ...input,
  })
  if (response.type === 'open-pane') return { type: 'open-pane', content: response.content }
  if (response.type === 'close-tab') return { type: 'close-tab' }
  if (response.type === 'new-session') return { type: 'new-session' }
  if (response.type === 'new-workspace') return { type: 'new-workspace' }
  if (response.type === 'closed') return { type: 'closed' }
  throw new Error(`unexpected overlay response: ${response.type}`)
}

export async function openUniversalMenuOverlay(
  input: EnvOverlayInput & {
    workspaceId?: string
    workspaceName?: string
    workspaceFolderId?: string | null
    activeSessionId?: string | null
    hasActiveTab: boolean
    contextItems?: UniversalMenuContextItem[]
    canToggleAgentPane?: boolean
    canToggleSidebar?: boolean
  },
): Promise<UniversalMenuOverlayResult> {
  const response = await openOverlayRequest({
    requestId: makeOverlayRequestId(),
    type: 'universal-menu',
    ...input,
  })
  if (response.type === 'open-pane') return { type: 'open-pane', content: response.content }
  if (response.type === 'created-agent-chat') return { type: 'created-agent-chat', sessionId: response.sessionId, workspaceId: response.workspaceId }
  if (response.type === 'switch-workspace') return { type: 'switch-workspace', workspaceId: response.workspaceId }
  if (response.type === 'close-tab') return { type: 'close-tab' }
  if (response.type === 'toggle-agent-pane') return { type: 'toggle-agent-pane' }
  if (response.type === 'toggle-sidebar') return { type: 'toggle-sidebar' }
  if (response.type === 'open-settings') return { type: 'open-settings' }
  if (response.type === 'closed') return { type: 'closed' }
  throw new Error(`unexpected overlay response: ${response.type}`)
}

export async function openConfirmOverlay(input: {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}): Promise<boolean> {
  const response = await openOverlayRequest({
    requestId: makeOverlayRequestId(),
    type: 'confirm',
    ...input,
  })
  if (response.type === 'confirmed') return response.confirmed
  if (response.type === 'closed') return false
  throw new Error(`unexpected overlay response: ${response.type}`)
}

export async function openTextInputOverlay(input: {
  title: string
  message?: string
  label: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
}): Promise<string | null> {
  const response = await openOverlayRequest({
    requestId: makeOverlayRequestId(),
    type: 'text-input',
    ...input,
  })
  if (response.type === 'text-submitted') return response.value
  if (response.type === 'closed') return null
  throw new Error(`unexpected overlay response: ${response.type}`)
}

export async function openRepoConfigOverlay(input: { configId: string }): Promise<boolean> {
  const response = await openOverlayRequest({
    requestId: makeOverlayRequestId(),
    type: 'repo-config',
    configId: input.configId,
  })
  if (response.type === 'repo-config-closed') return response.changed
  if (response.type === 'closed') return false
  throw new Error(`unexpected overlay response: ${response.type}`)
}

export async function openNewRepoConfigOverlay(): Promise<string | null> {
  const response = await openOverlayRequest({
    requestId: makeOverlayRequestId(),
    type: 'new-repo-config',
  })
  if (response.type === 'repo-config-created') return response.configId
  if (response.type === 'closed') return null
  throw new Error(`unexpected overlay response: ${response.type}`)
}

export async function openProviderCredentialsOverlay(input: {
  provider: 'anthropic' | 'openai'
  label: string
  hasApiKey: boolean
  baseUrl: string | null
}): Promise<boolean> {
  const response = await openOverlayRequest({
    requestId: makeOverlayRequestId(),
    type: 'provider-credentials',
    ...input,
  })
  if (response.type === 'provider-credentials-saved') return true
  if (response.type === 'closed') return false
  throw new Error(`unexpected overlay response: ${response.type}`)
}

export async function openWorkspaceCleanupOverlay(input: EnvOverlayInput & {
  workspace: { id: string; name: string }
  allWorkspaces: Array<{ id: string; name: string }>
  resources: WorkspaceResourceRecord[]
}): Promise<boolean> {
  const response = await openOverlayRequest({
    requestId: makeOverlayRequestId(),
    type: 'workspace-cleanup',
    ...input,
  })
  if (response.type === 'workspace-cleanup-complete') return true
  if (response.type === 'closed') return false
  throw new Error(`unexpected overlay response: ${response.type}`)
}

export async function openCreateBookmarkOverlay(input: CreateBookmarkOverlayInput): Promise<string | null> {
  const response = await openOverlayRequest({
    requestId: makeOverlayRequestId(),
    type: 'create-bookmark',
    ...input,
  })
  if (response.type === 'bookmark-saved') return response.bookmarkId
  if (response.type === 'closed') return null
  throw new Error(`unexpected overlay response: ${response.type}`)
}

export async function openBrowserUrlPopoverOverlay(input: BrowserUrlPopoverInput, onSelect: (resultId: string) => void): Promise<BrowserUrlPopoverSession | null> {
  if (!browserApi.isAvailable()) return null
  const requestId = makeOverlayRequestId()
  let closed = false
  await ensureElectronOverlay()
  if (!detachedOverlayId) return null
  const channel = new BroadcastChannel(OVERLAY_CHANNEL)
  const post = (next: BrowserUrlPopoverInput) => {
    channel.postMessage({ requestId, type: 'browser-url-popover', ...next } satisfies OverlayRequest)
  }
  channel.onmessage = (event: MessageEvent<OverlayResponse>) => {
    const response = event.data
    if (response.requestId !== requestId) return
    if (response.type === 'browser-url-popover-selected') onSelect(response.resultId)
    close()
  }
  const width = Math.max(1, window.innerWidth)
  const height = Math.max(1, window.innerHeight)
  await browserApi.attachOverlay({ overlayId: detachedOverlayId, placement: { x: 0, y: 0, w: width, h: height } })
  post(input)

  function close() {
    if (closed) return
    closed = true
    channel.postMessage({ type: 'close' })
    channel.close()
    if (detachedOverlayId) void browserApi.detachOverlay({ overlayId: detachedOverlayId }).catch(() => undefined)
  }

  return {
    requestId,
    update(next) {
      if (!closed) post(next)
    },
    close,
  }
}

async function openOverlayRequest(request: OverlayRequest): Promise<OverlayResponse> {
  if (request.type !== 'confirm'
    && request.type !== 'text-input'
    && request.type !== 'repo-config'
    && request.type !== 'new-repo-config'
    && request.type !== 'provider-credentials'
    && request.type !== 'create-bookmark'
    && request.type !== 'browser-url-popover'
    && !request.envToken) {
    throw new Error('env token is required for env overlays')
  }

  if (browserApi.isAvailable()) {
    try {
      return await openElectronOverlay(request)
    } catch (e) {
      console.warn('webframe overlay unavailable; falling back to DOM overlay', e)
    }
  }
  return openFallbackOverlay(request)
}

async function openElectronOverlay(request: OverlayRequest): Promise<OverlayResponse> {
  await ensureElectronOverlay()
  if (!detachedOverlayId) throw new Error('overlay did not initialize')

  const width = Math.max(1, window.innerWidth)
  const height = Math.max(1, window.innerHeight)
  await browserApi.attachOverlay({ overlayId: detachedOverlayId, placement: { x: 0, y: 0, w: width, h: height } })
  await browserApi.focusOverlay({ overlayId: detachedOverlayId })

  const channel = new BroadcastChannel(OVERLAY_CHANNEL)
  try {
    return await new Promise<OverlayResponse>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('overlay modal timed out')), 120_000)
      channel.onmessage = (event: MessageEvent<OverlayResponse>) => {
        const response = event.data
        if (response.requestId !== request.requestId) return
        window.clearTimeout(timeout)
        if (response.type === 'error') reject(new Error(response.message))
        else resolve(response)
      }
      channel.postMessage(request)
    })
  } finally {
    channel.close()
    await browserApi.detachOverlay({ overlayId: detachedOverlayId })
  }
}

async function ensureElectronOverlay(): Promise<void> {
  if (detachedOverlayId) return readyPromise ?? Promise.resolve()
  const pendingReady = waitForOverlayReady()
  readyPromise = pendingReady
  try {
    const { overlayId } = await withTimeout(browserApi.createDetachedOverlay({
      url: `${window.location.origin}/internal/overlay-layer`,
      transparent: true,
      clickThrough: false,
    }), 5_000, 'overlay create timed out')
    detachedOverlayId = overlayId
    await pendingReady
  } catch (e) {
    const overlayId = detachedOverlayId
    detachedOverlayId = null
    readyPromise = null
    if (overlayId) {
      await browserApi.closeOverlay({ overlayId }).catch(() => undefined)
    }
    throw e
  }
}

function waitForOverlayReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(OVERLAY_CHANNEL)
    const timeout = window.setTimeout(() => {
      channel.close()
      reject(new Error('overlay layer did not become ready'))
    }, 5_000)
    channel.onmessage = (event: MessageEvent<OverlayResponse>) => {
      if (event.data.type !== 'ready') return
      window.clearTimeout(timeout)
      channel.close()
      resolve()
    }
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

function openFallbackOverlay(request: OverlayRequest): Promise<OverlayResponse> {
  const host = document.createElement('div')
  host.dataset.overlayRoot = 'true'
  document.body.appendChild(host)
  let root: Root | null = createRoot(host)
  const queryClient = new QueryClient()
  const trpcClient = makeTrpcClient()

  function cleanup() {
    root?.unmount()
    root = null
    host.remove()
  }

  return new Promise((resolve, reject) => {
    root?.render(
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <OverlayLayerApp
            initialRequest={request}
            onResponse={(response) => {
              if (response.requestId !== request.requestId) return
              cleanup()
              if (response.type === 'error') reject(new Error(response.message))
              else resolve(response)
            }}
          />
        </QueryClientProvider>
      </trpc.Provider>,
    )
  })
}

function makeOverlayRequestId(): string {
  return `overlay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
