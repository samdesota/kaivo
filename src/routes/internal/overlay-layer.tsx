import { useEffect, useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { EnvRef } from '../../lib/env-client'
import { envTrpc, makeManagedEnvReactClient } from '../../env-trpc'
import { EnvContextProvider } from '../env/env-context'
import { NewAgentChatOverlay } from '../env/agent/new-agent-chat-modal'

export const OVERLAY_CHANNEL = 'cloud-code-overlay-layer'

export type OverlayRequest = {
  requestId: string
  type: 'new-agent-chat'
  workspaceId: string
  env: EnvRef & { label: string }
  envToken: string
}

export type OverlayResponse =
  | { requestId: string; type: 'ready' }
  | { requestId: string; type: 'closed' }
  | { requestId: string; type: 'created-agent-chat'; sessionId: string }
  | { requestId: string; type: 'error'; message: string }

export function OverlayLayerPage() {
  useEffect(() => {
    document.documentElement.classList.add('overlay-layer-document')
    document.body.classList.add('overlay-layer-document')
    document.getElementById('root')?.classList.add('overlay-layer-document')
    return () => {
      document.documentElement.classList.remove('overlay-layer-document')
      document.body.classList.remove('overlay-layer-document')
      document.getElementById('root')?.classList.remove('overlay-layer-document')
    }
  }, [])

  return <OverlayLayerApp />
}

export function OverlayLayerApp({
  initialRequest,
  onResponse,
}: {
  initialRequest?: OverlayRequest
  onResponse?: (response: OverlayResponse) => void
}) {
  const [request, setRequest] = useState<OverlayRequest | null>(initialRequest ?? null)

  useEffect(() => {
    if (initialRequest) return
    const channel = new BroadcastChannel(OVERLAY_CHANNEL)
    channel.postMessage({ requestId: 'overlay-layer', type: 'ready' } satisfies OverlayResponse)
    channel.onmessage = (event: MessageEvent<OverlayRequest | { type: 'close' }>) => {
      if (event.data.type === 'new-agent-chat') setRequest(event.data)
      if (event.data.type === 'close') setRequest(null)
    }
    return () => channel.close()
  }, [initialRequest])

  function respond(response: OverlayResponse) {
    if (onResponse) {
      onResponse(response)
      return
    }
    const channel = new BroadcastChannel(OVERLAY_CHANNEL)
    channel.postMessage(response)
    channel.close()
  }

  if (!request) return <div className="min-h-screen bg-transparent" />

  return <OverlayRequestRenderer request={request} respond={respond} />
}

function OverlayRequestRenderer({
  request,
  respond,
}: {
  request: OverlayRequest
  respond: (response: OverlayResponse) => void
}) {
  const queryClient = useMemo(() => new QueryClient(), [request.requestId])
  const managedEnvClient = useMemo(
    () => makeManagedEnvReactClient(request.env, request.envToken),
    [request.env.id, request.env.url, request.envToken],
  )
  useEffect(() => {
    return () => {
      void managedEnvClient.close()
    }
  }, [managedEnvClient])

  return (
    <QueryClientProvider client={queryClient}>
      <envTrpc.Provider client={managedEnvClient.client} queryClient={queryClient}>
        <EnvContextProvider value={{ env: request.env, envToken: request.envToken }}>
          <NewAgentChatOverlay
            workspaceId={request.workspaceId}
            onClose={() => respond({ requestId: request.requestId, type: 'closed' })}
            onCreated={(sessionId) => respond({ requestId: request.requestId, type: 'created-agent-chat', sessionId })}
          />
        </EnvContextProvider>
      </envTrpc.Provider>
    </QueryClientProvider>
  )
}
