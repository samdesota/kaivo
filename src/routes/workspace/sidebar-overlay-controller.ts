import { browserApi } from '../../lib/browser-api'
import type { WorkspaceSidebarStateSnapshot } from './sidebar-state'

export type WorkspaceSidebarOverlayAction =
  | { type: 'show-preview' }
  | { type: 'hide-preview' }
  | { type: 'hide-sidebar' }
  | { type: 'new-workspace' }
  | { type: 'navigate-workspace'; workspaceId: string }
  | { type: 'navigate-settings' }
  | { type: 'select-global-tab'; tabId: string }
  | { type: 'leave-global-tabs' }
  | { type: 'close-global-tab'; tabId: string }
  | { type: 'request-state' }
  | { type: 'dismiss-notification'; notificationId: string }
  | { type: 'clear-notifications'; notificationIds: string[] }
  | { type: 'open-notification'; notificationId: string }
  | { type: 'mark-workspace-chats-read'; workspaceId: string }

export type WorkspaceSidebarOverlayCommand =
  | { type: 'set-previewed'; previewed: boolean }
  | { type: 'set-hover-visible'; visible: boolean }
  | { type: 'set-active-global-tab'; tabId: string | null }
  | { type: 'set-state'; state: WorkspaceSidebarStateSnapshot }

export type WorkspaceSidebarOverlaySession = {
  showHover(): Promise<void>
  showPreview(input: { sidebarWidth?: number }): Promise<void>
  update(input: { globalTabId: string | null; sidebarState?: WorkspaceSidebarStateSnapshot | null }): void
  hidePreview(): void
  detach(): void
  close(): void
}

export type WorkspaceSidebarOverlayTarget = {
  hidden: boolean
  previewed: boolean
  workspaceId: string
  globalTabId: string | null
  sidebarWidth: number
  sidebarState: WorkspaceSidebarStateSnapshot | null
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
  sidebarState?: WorkspaceSidebarStateSnapshot | null
  onAction: (action: WorkspaceSidebarOverlayAction) => void
}): Promise<WorkspaceSidebarOverlaySession | null> {
  if (!browserApi.isAvailable()) {
    return null
  }

  const channelName = `kaivo-sidebar-overlay:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
  const channel = new BroadcastChannel(channelName)
  let closed = false
  let attached = false
  let shrinkTimer: number | null = null
  const hoverWidth = 8
  const hoverHeight = 100
  const url = new URL('/internal/workspace-sidebar-overlay', window.location.origin)
  url.searchParams.set('workspaceId', input.workspaceId)
  url.searchParams.set('channel', channelName)
  if (input.globalTabId) url.searchParams.set('globalTabId', input.globalTabId)

  const { overlayId } = await browserApi.createDetachedOverlay({
    url: url.toString(),
    transparent: true,
    clickThrough: false,
  })
  async function showHover() {
    if (closed) return
    if (shrinkTimer !== null) {
      window.clearTimeout(shrinkTimer)
      shrinkTimer = null
    }
    attached = true
    await browserApi.attachOverlay({
      overlayId,
      placement: {
        x: 0,
        y: Math.max(0, Math.round((window.innerHeight - hoverHeight) / 2)),
        w: hoverWidth,
        h: hoverHeight,
      },
    })
    channel.postMessage({ type: 'set-previewed', previewed: false } satisfies WorkspaceSidebarOverlayCommand)
    channel.postMessage({ type: 'set-hover-visible', visible: true } satisfies WorkspaceSidebarOverlayCommand)
  }

  async function showPreview(next: { sidebarWidth?: number }) {
    if (closed) return
    if (shrinkTimer !== null) {
      window.clearTimeout(shrinkTimer)
      shrinkTimer = null
    }
    attached = true
    await browserApi.attachOverlay({
      overlayId,
      placement: { x: 0, y: 0, w: Math.max(1, next.sidebarWidth ?? input.sidebarWidth ?? 256), h: Math.max(1, window.innerHeight) },
    })
    await browserApi.focusOverlay({ overlayId })
    channel.postMessage({ type: 'set-hover-visible', visible: false } satisfies WorkspaceSidebarOverlayCommand)
    channel.postMessage({ type: 'set-previewed', previewed: true } satisfies WorkspaceSidebarOverlayCommand)
  }

  function update(next: { globalTabId: string | null; sidebarState?: WorkspaceSidebarStateSnapshot | null }) {
    if (closed) return
    channel.postMessage({ type: 'set-active-global-tab', tabId: next.globalTabId } satisfies WorkspaceSidebarOverlayCommand)
    const state = next.sidebarState ?? input.sidebarState ?? null
    if (state) channel.postMessage({ type: 'set-state', state } satisfies WorkspaceSidebarOverlayCommand)
  }

  function hidePreview() {
    if (closed) return
    channel.postMessage({ type: 'set-hover-visible', visible: false } satisfies WorkspaceSidebarOverlayCommand)
    channel.postMessage({ type: 'set-previewed', previewed: false } satisfies WorkspaceSidebarOverlayCommand)
    if (shrinkTimer !== null) window.clearTimeout(shrinkTimer)
    shrinkTimer = window.setTimeout(() => {
      shrinkTimer = null
      void showHover().catch(() => undefined)
    }, 220)
  }

  function detach() {
    if (closed || !attached) return
    attached = false
    if (shrinkTimer !== null) {
      window.clearTimeout(shrinkTimer)
      shrinkTimer = null
    }
    channel.postMessage({ type: 'set-previewed', previewed: false } satisfies WorkspaceSidebarOverlayCommand)
    void browserApi.detachOverlay({ overlayId }).catch(() => undefined)
  }

  function close() {
    if (closed) return
    closed = true
    if (shrinkTimer !== null) {
      window.clearTimeout(shrinkTimer)
      shrinkTimer = null
    }
    channel.close()
    if (attached) void browserApi.detachOverlay({ overlayId }).catch(() => undefined)
    void browserApi.closeOverlay({ overlayId }).catch(() => undefined)
  }

  channel.onmessage = (event: MessageEvent<WorkspaceSidebarOverlayAction>) => {
    input.onAction(event.data)
    if (
      event.data.type === 'navigate-workspace'
      || event.data.type === 'navigate-settings'
      || event.data.type === 'select-global-tab'
      || event.data.type === 'leave-global-tabs'
      || event.data.type === 'open-notification'
    ) hidePreview()
    if (event.data.type === 'hide-sidebar') detach()
  }

  return { showHover, showPreview, update, hidePreview, detach, close }
}
