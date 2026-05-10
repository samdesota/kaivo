import { useEffect, useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { EnvRef } from '../../lib/env-client'
import { envTrpc, makeManagedEnvReactClient } from '../../env-trpc'
import { EnvContextProvider } from '../env/env-context'
import { NewAgentChatOverlay } from '../env/agent/new-agent-chat-modal'
import type { NewAgentChatWorkspaceMode } from '../env/agent/new-agent-chat-state'
import { FolderPickerModal } from '../env/agent/folder-picker-modal'
import { CommandPalette } from '../env/shell/command-palette'
import type { PaneContent } from '../env/shell/tab-state'
import { Modal } from '../../components/ui'

export const OVERLAY_CHANNEL = 'cloud-code-overlay-layer'

export type OverlayRequest = {
  requestId: string
  type: 'new-agent-chat'
  workspaceId?: string
  workspaceName?: string
  initialWorkspaceMode?: NewAgentChatWorkspaceMode
  folderId?: string | null
  env: EnvRef & { label: string }
  envToken: string
} | {
  requestId: string
  type: 'folder-picker'
  env: EnvRef & { label: string }
  envToken: string
  title?: string
  busy?: boolean
} | {
  requestId: string
  type: 'command-palette'
  env: EnvRef & { label: string }
  envToken: string
  workspaceId?: string
  activeSessionId?: string | null
  hasActiveTab: boolean
} | {
  requestId: string
  type: 'confirm'
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
} | {
  requestId: string
  type: 'text-input'
  title: string
  message?: string
  label: string
  initialValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
}

export type OverlayResponse =
  | { requestId: string; type: 'ready' }
  | { requestId: string; type: 'closed' }
  | { requestId: string; type: 'created-agent-chat'; sessionId: string; workspaceId?: string }
  | { requestId: string; type: 'selected-folder'; path: string }
  | { requestId: string; type: 'open-pane'; content: PaneContent }
  | { requestId: string; type: 'close-tab' }
  | { requestId: string; type: 'confirmed'; confirmed: boolean }
  | { requestId: string; type: 'text-submitted'; value: string }
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
    channel.onmessage = (event: MessageEvent<OverlayRequest | OverlayResponse | { type: 'close' }>) => {
      if (isOverlayRequest(event.data)) setRequest(event.data)
      if (event.data.type === 'close') setRequest(null)
    }
    return () => channel.close()
  }, [initialRequest])

  function respond(response: OverlayResponse) {
    setRequest(null)
    if (onResponse) {
      onResponse(response)
      return
    }
    const channel = new BroadcastChannel(OVERLAY_CHANNEL)
    channel.postMessage(response)
    channel.close()
  }

  if (!request) return <div className="min-h-screen bg-transparent" />

  return <OverlayRequestRenderer key={request.requestId} request={request} respond={respond} />
}

function isOverlayRequest(message: OverlayRequest | OverlayResponse | { type: 'close' }): message is OverlayRequest {
  return message.type === 'new-agent-chat'
    || message.type === 'folder-picker'
    || message.type === 'command-palette'
    || message.type === 'confirm'
    || message.type === 'text-input'
}

function OverlayRequestRenderer({
  request,
  respond,
}: {
  request: OverlayRequest
  respond: (response: OverlayResponse) => void
}) {
  if (request.type === 'confirm') {
    return <ConfirmOverlay request={request} respond={respond} />
  }
  if (request.type === 'text-input') {
    return <TextInputOverlay request={request} respond={respond} />
  }

  return <EnvOverlayRequestRenderer request={request} respond={respond} />
}

function EnvOverlayRequestRenderer({
  request,
  respond,
}: {
  request: Exclude<OverlayRequest, { type: 'confirm' | 'text-input' }>
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
          {request.type === 'new-agent-chat' && (
            <NewAgentChatOverlay
              workspaceId={request.workspaceId}
              workspaceName={request.workspaceName}
              initialWorkspaceMode={request.initialWorkspaceMode}
              folderId={request.folderId}
              onClose={() => respond({ requestId: request.requestId, type: 'closed' })}
              onCreated={(sessionId, workspaceId) => respond({ requestId: request.requestId, type: 'created-agent-chat', sessionId, workspaceId })}
            />
          )}
          {request.type === 'folder-picker' && (
            <FolderPickerModal
              open
              title={request.title}
              busy={request.busy}
              onClose={() => respond({ requestId: request.requestId, type: 'closed' })}
              onSelect={(path) => respond({ requestId: request.requestId, type: 'selected-folder', path })}
            />
          )}
          {request.type === 'command-palette' && (
            <CommandPalette
              open
              workspaceId={request.workspaceId}
              activeSessionId={request.activeSessionId}
              hasActiveTab={request.hasActiveTab}
              onClose={() => respond({ requestId: request.requestId, type: 'closed' })}
              onOpenContent={(content) => respond({ requestId: request.requestId, type: 'open-pane', content })}
              onCloseTab={() => respond({ requestId: request.requestId, type: 'close-tab' })}
            />
          )}
        </EnvContextProvider>
      </envTrpc.Provider>
    </QueryClientProvider>
  )
}

function TextInputOverlay({
  request,
  respond,
}: {
  request: Extract<OverlayRequest, { type: 'text-input' }>
  respond: (response: OverlayResponse) => void
}) {
  const [value, setValue] = useState(request.initialValue ?? '')
  const trimmed = value.trim()
  function close() {
    respond({ requestId: request.requestId, type: 'closed' })
  }
  function submit() {
    if (!trimmed) return
    respond({ requestId: request.requestId, type: 'text-submitted', value: trimmed })
  }
  return (
    <Modal open onClose={close} title={request.title} widthClass="max-w-sm">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {request.message && <p className="text-xs text-neutral-500">{request.message}</p>}
        <label className="block space-y-1 text-xs text-neutral-400">
          <span>{request.label}</span>
          <input
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={request.placeholder}
            className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-600"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={close}
            className="rounded px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-900"
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="submit"
            disabled={!trimmed}
            className="rounded bg-neutral-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-600 disabled:opacity-50"
          >
            {request.confirmLabel ?? 'Submit'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function ConfirmOverlay({
  request,
  respond,
}: {
  request: Extract<OverlayRequest, { type: 'confirm' }>
  respond: (response: OverlayResponse) => void
}) {
  const close = (confirmed: boolean) => respond({ requestId: request.requestId, type: 'confirmed', confirmed })
  return (
    <Modal open onClose={() => close(false)} title={request.title} widthClass="max-w-md">
      <div className="space-y-4">
        <p className="whitespace-pre-wrap text-sm text-neutral-300">{request.message}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => close(false)}
            className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 hover:bg-neutral-800"
          >
            {request.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            onClick={() => close(true)}
            className={
              'rounded px-3 py-1.5 text-sm font-medium text-white ' +
              (request.destructive ? 'bg-red-600 hover:bg-red-500' : 'bg-neutral-700 hover:bg-neutral-600')
            }
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
