import { browserApi } from '../../lib/browser-api'

export type WorkspaceSidebarOverlayAction =
  | { type: 'hide-preview' }
  | { type: 'hide-sidebar' }
  | { type: 'new-workspace' }
  | { type: 'navigate-workspace'; workspaceId: string }
  | { type: 'navigate-settings' }
  | { type: 'select-global-tab'; tabId: string }
  | { type: 'leave-global-tabs' }
  | { type: 'close-global-tab'; tabId: string }

export type WorkspaceSidebarOverlayCommand =
  | { type: 'set-previewed'; previewed: boolean }
  | { type: 'set-active-global-tab'; tabId: string | null }

export type WorkspaceSidebarOverlaySession = {
  attach(input: { sidebarWidth?: number }): Promise<void>
  update(input: { globalTabId: string | null }): void
  detach(): void
  close(): void
}

export type WorkspaceSidebarOverlayTarget = {
  hidden: boolean
  previewed: boolean
  workspaceId: string
  globalTabId: string | null
  sidebarWidth: number
  onAction: (action: WorkspaceSidebarOverlayAction) => void
}

let overlayTarget: WorkspaceSidebarOverlayTarget | null = null
const overlayTargetListeners = new Set<() => void>()

export function setWorkspaceSidebarOverlayTarget(target: WorkspaceSidebarOverlayTarget | null): void {
  overlayTarget = target
  for (const listener of overlayTargetListeners) listener()
}

export function clearWorkspaceSidebarOverlayTarget(target: WorkspaceSidebarOverlayTarget): void {
  window.setTimeout(() => {
    if (overlayTarget !== target) return
    setWorkspaceSidebarOverlayTarget(null)
  }, 0)
}

export function subscribeWorkspaceSidebarOverlayTarget(listener: () => void): () => void {
  overlayTargetListeners.add(listener)
  return () => overlayTargetListeners.delete(listener)
}

export function getWorkspaceSidebarOverlayTarget(): WorkspaceSidebarOverlayTarget | null {
  return overlayTarget
}

export async function openWorkspaceSidebarOverlay(input: {
  workspaceId: string
  globalTabId?: string | null
  sidebarWidth?: number
  onAction: (action: WorkspaceSidebarOverlayAction) => void
}): Promise<WorkspaceSidebarOverlaySession | null> {
  if (!browserApi.isAvailable()) {
    return null
  }

  const channelName = `kaivo-sidebar-overlay:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const channel = new BroadcastChannel(channelName)
  let closed = false
  let attached = false
  const url = new URL('/internal/workspace-sidebar-overlay', window.location.origin)
  url.searchParams.set('workspaceId', input.workspaceId)
  url.searchParams.set('channel', channelName)
  if (input.globalTabId) url.searchParams.set('globalTabId', input.globalTabId)

  const { overlayId } = await browserApi.createDetachedOverlay({
    url: url.toString(),
    transparent: true,
    clickThrough: false,
  })
  async function attach(next: { sidebarWidth?: number }) {
    if (closed) return
    attached = true
    await browserApi.attachOverlay({
      overlayId,
      placement: { x: 0, y: 0, w: Math.max(1, next.sidebarWidth ?? input.sidebarWidth ?? 256), h: Math.max(1, window.innerHeight) },
    })
    await browserApi.focusOverlay({ overlayId })
    channel.postMessage({ type: 'set-previewed', previewed: true } satisfies WorkspaceSidebarOverlayCommand)
  }

  function update(next: { globalTabId: string | null }) {
    if (closed) return
    channel.postMessage({ type: 'set-active-global-tab', tabId: next.globalTabId } satisfies WorkspaceSidebarOverlayCommand)
  }

  function detach() {
    if (closed || !attached) return
    attached = false
    channel.postMessage({ type: 'set-previewed', previewed: false } satisfies WorkspaceSidebarOverlayCommand)
    window.setTimeout(() => {
      void browserApi.detachOverlay({ overlayId }).catch(() => undefined)
    }, 220)
  }

  function close() {
    if (closed) return
    closed = true
    channel.close()
    if (attached) void browserApi.detachOverlay({ overlayId }).catch(() => undefined)
    void browserApi.closeOverlay({ overlayId }).catch(() => undefined)
  }

  channel.onmessage = (event: MessageEvent<WorkspaceSidebarOverlayAction>) => {
    input.onAction(event.data)
    if (event.data.type === 'hide-preview' || event.data.type === 'hide-sidebar') detach()
  }

  return { attach, update, detach, close }
}
