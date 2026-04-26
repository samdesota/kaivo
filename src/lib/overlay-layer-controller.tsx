import { createRoot, type Root } from 'react-dom/client'
import type { EnvRef } from './env-client'
import { browserApi } from './browser-api'
import { OVERLAY_CHANNEL, OverlayLayerApp, type OverlayRequest, type OverlayResponse } from '../routes/internal/overlay-layer'

type NewAgentChatInput = {
  workspaceId: string
  env: EnvRef & { label: string }
  envToken: string
}

let detachedOverlayId: string | null = null
let readyPromise: Promise<void> | null = null

export async function openNewAgentChatOverlay(input: NewAgentChatInput): Promise<string | null> {
  const request: OverlayRequest = {
    requestId: `overlay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'new-agent-chat',
    ...input,
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

async function openElectronOverlay(request: OverlayRequest): Promise<string | null> {
  await ensureElectronOverlay()
  if (!detachedOverlayId) throw new Error('overlay did not initialize')

  const width = Math.max(1, window.innerWidth)
  const height = Math.max(1, window.innerHeight)
  await browserApi.attachOverlay({ overlayId: detachedOverlayId, placement: { x: 0, y: 0, w: width, h: height } })

  const channel = new BroadcastChannel(OVERLAY_CHANNEL)
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('overlay modal timed out')), 120_000)
      channel.onmessage = (event: MessageEvent<OverlayResponse>) => {
        const response = event.data
        if (response.requestId !== request.requestId) return
        window.clearTimeout(timeout)
        if (response.type === 'created-agent-chat') resolve(response.sessionId)
        else if (response.type === 'closed') resolve(null)
        else if (response.type === 'error') reject(new Error(response.message))
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
  readyPromise = waitForOverlayReady()
  const { overlayId } = await browserApi.createDetachedOverlay({
    url: `${window.location.origin}/internal/overlay-layer`,
    transparent: true,
    clickThrough: false,
  })
  detachedOverlayId = overlayId
  await readyPromise
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

function openFallbackOverlay(request: OverlayRequest): Promise<string | null> {
  const host = document.createElement('div')
  host.dataset.overlayRoot = 'true'
  document.body.appendChild(host)
  let root: Root | null = createRoot(host)

  function cleanup() {
    root?.unmount()
    root = null
    host.remove()
  }

  return new Promise((resolve, reject) => {
    root?.render(
      <OverlayLayerApp
        initialRequest={request}
        onResponse={(response) => {
          if (response.requestId !== request.requestId) return
          cleanup()
          if (response.type === 'created-agent-chat') resolve(response.sessionId)
          else if (response.type === 'closed') resolve(null)
          else if (response.type === 'error') reject(new Error(response.message))
        }}
      />,
    )
  })
}
