import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { EnvRef } from '../../lib/env-client'
import { envTrpc, makeManagedEnvReactClient } from '../../env-trpc'
import { EnvContextProvider } from '../env/env-context'
import { NewAgentChatOverlay } from '../env/agent/new-agent-chat-modal'
import type { NewAgentChatSelection, NewAgentChatWorkspaceMode } from '../env/agent/new-agent-chat-state'
import { FolderPickerModal } from '../env/agent/folder-picker-modal'
import { CommandPalette } from '../env/shell/command-palette'
import type { PaneContent } from '../env/shell/tab-state'
import { UniversalMenu, type UniversalMenuContextItem, type UniversalMenuInitialIntent } from '../env/universal-menu/universal-menu'
import { Modal } from '../../components/ui'
import { NewRepoConfigForm, RepoConfigEditor } from '../repo-config-manager'
import { ProviderCredentialsOverlay } from '../settings/provider-credentials-overlay'
import { WorkspaceCleanupOverlay } from '../workspace/workspace-cleanup-overlay'
import type { WorkspaceResourceRecord } from '../workspace/resources-store'
import { bookmarkOriginForUrl, upsertWorkspaceBookmark } from '../workspace/bookmarks-store'
import { resolveBrowserAddress } from '../../lib/browser-navigation'

/**
 * Detached modal layer rendered at /internal/overlay-layer.
 *
 * App code sends typed requests through lib/overlay-layer-controller. App data
 * is available through the root trpc provider; env-backed overlays receive env
 * credentials in the request and get an envTrpc provider below.
 */

export const OVERLAY_CHANNEL = 'cloud-code-overlay-layer'

export type OverlayRequest = {
  requestId: string
  type: 'new-agent-chat'
  workspaceId?: string
  workspaceName?: string
  initialWorkspaceMode?: NewAgentChatWorkspaceMode
  initialSelection?: NewAgentChatSelection
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
  type: 'universal-menu'
  env: EnvRef & { label: string }
  envToken: string
  workspaceId?: string
  workspaceName?: string
  workspaceFolderId?: string | null
  activeSessionId?: string | null
  hasActiveTab: boolean
  contextItems?: UniversalMenuContextItem[]
  canToggleAgentPane?: boolean
  canToggleSidebar?: boolean
  initialIntent?: UniversalMenuInitialIntent
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
} | {
  requestId: string
  type: 'repo-config'
  configId: string
} | {
  requestId: string
  type: 'new-repo-config'
} | {
  requestId: string
  type: 'provider-credentials'
  provider: 'anthropic' | 'openai'
  label: string
  hasApiKey: boolean
  baseUrl: string | null
} | {
  requestId: string
  type: 'workspace-cleanup'
  workspace: { id: string; name: string }
  allWorkspaces: Array<{ id: string; name: string }>
  resources: WorkspaceResourceRecord[]
  env: EnvRef & { label: string }
  envToken: string
} | {
  requestId: string
  type: 'create-bookmark'
  workspaceId: string
  initialTitle?: string
  initialUrl: string
  initialFaviconDataUrl?: string | null
  initialFaviconUrl?: string | null
} | {
  requestId: string
  type: 'browser-url-popover'
  anchor: { left: number; top: number; width: number }
  results: BrowserUrlPopoverResult[]
  activeIndex: number | null
}

export type BrowserUrlPopoverResult =
  | { id: string; kind: 'bookmark'; title: string; detail: string; iconUrl?: string | null }
  | { id: string; kind: 'search'; title: string }

export type OverlayResponse =
  | { requestId: string; type: 'ready' }
  | { requestId: string; type: 'closed' }
  | { requestId: string; type: 'created-agent-chat'; sessionId: string; workspaceId?: string }
  | { requestId: string; type: 'switch-workspace'; workspaceId: string }
  | { requestId: string; type: 'selected-folder'; path: string }
  | { requestId: string; type: 'open-pane'; content: PaneContent }
  | { requestId: string; type: 'close-tab' }
  | { requestId: string; type: 'new-session' }
  | { requestId: string; type: 'new-workspace' }
  | { requestId: string; type: 'toggle-agent-pane' }
  | { requestId: string; type: 'toggle-sidebar' }
  | { requestId: string; type: 'open-settings' }
  | { requestId: string; type: 'confirmed'; confirmed: boolean }
  | { requestId: string; type: 'text-submitted'; value: string }
  | { requestId: string; type: 'repo-config-closed'; changed: boolean }
  | { requestId: string; type: 'repo-config-created'; configId: string }
  | { requestId: string; type: 'provider-credentials-saved' }
  | { requestId: string; type: 'workspace-cleanup-complete' }
  | { requestId: string; type: 'bookmark-saved'; bookmarkId: string }
  | { requestId: string; type: 'browser-url-popover-selected'; resultId: string }
  | { requestId: string; type: 'browser-url-popover-closed' }
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
    || message.type === 'universal-menu'
    || message.type === 'confirm'
    || message.type === 'text-input'
    || message.type === 'repo-config'
    || message.type === 'new-repo-config'
    || message.type === 'provider-credentials'
    || message.type === 'workspace-cleanup'
    || message.type === 'create-bookmark'
    || message.type === 'browser-url-popover'
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
  if (request.type === 'repo-config') {
    return <RepoConfigOverlay request={request} respond={respond} />
  }
  if (request.type === 'new-repo-config') {
    return <NewRepoConfigOverlay request={request} respond={respond} />
  }
  if (request.type === 'provider-credentials') {
    return <ProviderCredentialsOverlayRenderer request={request} respond={respond} />
  }
  if (request.type === 'create-bookmark') {
    return <CreateBookmarkOverlay request={request} respond={respond} />
  }
  if (request.type === 'browser-url-popover') {
    return <BrowserUrlPopoverOverlay request={request} respond={respond} />
  }

  return <EnvOverlayRequestRenderer request={request} respond={respond} />
}

function EnvOverlayRequestRenderer({
  request,
  respond,
}: {
  request: Extract<OverlayRequest, { type: 'new-agent-chat' | 'folder-picker' | 'command-palette' | 'universal-menu' | 'workspace-cleanup' }>
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
              initialSelection={request.initialSelection}
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
              onNewSession={() => respond({ requestId: request.requestId, type: 'new-session' })}
              onNewWorkspace={() => respond({ requestId: request.requestId, type: 'new-workspace' })}
            />
          )}
          {request.type === 'universal-menu' && (
            <UniversalMenu
              open
              workspaceId={request.workspaceId}
              workspaceName={request.workspaceName}
              workspaceFolderId={request.workspaceFolderId}
              activeSessionId={request.activeSessionId}
              hasActiveTab={request.hasActiveTab}
              contextItems={request.contextItems}
              initialIntent={request.initialIntent}
              onClose={() => respond({ requestId: request.requestId, type: 'closed' })}
              onOpenContent={(content) => respond({ requestId: request.requestId, type: 'open-pane', content })}
              onCreatedChat={(sessionId: string, workspaceId?: string) => respond({ requestId: request.requestId, type: 'created-agent-chat', sessionId, workspaceId })}
              onSwitchWorkspace={(workspaceId: string) => respond({ requestId: request.requestId, type: 'switch-workspace', workspaceId })}
              onCloseTab={() => respond({ requestId: request.requestId, type: 'close-tab' })}
              onToggleAgentPane={request.canToggleAgentPane ? () => respond({ requestId: request.requestId, type: 'toggle-agent-pane' }) : undefined}
              onToggleSidebar={request.canToggleSidebar ? () => respond({ requestId: request.requestId, type: 'toggle-sidebar' }) : undefined}
              onOpenSettings={() => respond({ requestId: request.requestId, type: 'open-settings' })}
            />
          )}
          {request.type === 'workspace-cleanup' && (
            <WorkspaceCleanupOverlay
              workspace={request.workspace}
              allWorkspaces={request.allWorkspaces}
              resources={request.resources}
              onCancel={() => respond({ requestId: request.requestId, type: 'closed' })}
              onCleaned={() => respond({ requestId: request.requestId, type: 'workspace-cleanup-complete' })}
            />
          )}
        </EnvContextProvider>
      </envTrpc.Provider>
    </QueryClientProvider>
  )
}

function BrowserUrlPopoverOverlay({
  request,
  respond,
}: {
  request: Extract<OverlayRequest, { type: 'browser-url-popover' }>
  respond: (response: OverlayResponse) => void
}) {
  return (
    <div className="fixed inset-0 bg-transparent pointer-events-none">
      <div
        role="listbox"
        aria-label="URL bar results"
        className="absolute max-h-64 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950 py-1 shadow-lg pointer-events-auto"
        style={{ left: request.anchor.left, top: request.anchor.top, width: request.anchor.width }}
      >
        {request.results.map((result, index) => (
          <button
            key={result.id}
            type="button"
            role="option"
            aria-selected={request.activeIndex === index}
            onMouseDown={(event) => {
              event.preventDefault()
              respond({ requestId: request.requestId, type: 'browser-url-popover-selected', resultId: result.id })
            }}
            className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs ${request.activeIndex === index ? 'bg-neutral-900 text-neutral-100' : 'text-neutral-300 hover:bg-neutral-900'}`}
          >
            {result.kind === 'search' ? (
              <Search aria-hidden="true" size={12} strokeWidth={1.8} className="shrink-0 text-neutral-400" />
            ) : result.iconUrl ? (
              <img src={result.iconUrl} alt="" aria-hidden="true" className="h-3 w-3 shrink-0 rounded-[2px] object-contain" draggable={false} />
            ) : (
              <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full border border-neutral-600" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-neutral-200">{result.title}</span>
              {result.kind === 'bookmark' && <span className="block truncate text-neutral-500">{result.detail}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

function RepoConfigOverlay({
  request,
  respond,
}: {
  request: Extract<OverlayRequest, { type: 'repo-config' }>
  respond: (response: OverlayResponse) => void
}) {
  const close = (changed: boolean) => respond({ requestId: request.requestId, type: 'repo-config-closed', changed })
  return (
    <Modal open onClose={() => close(true)} title="Repo config" widthClass="max-w-2xl">
      <RepoConfigEditor configId={request.configId} onDeleted={() => close(true)} />
    </Modal>
  )
}

function NewRepoConfigOverlay({
  request,
  respond,
}: {
  request: Extract<OverlayRequest, { type: 'new-repo-config' }>
  respond: (response: OverlayResponse) => void
}) {
  return (
    <Modal open onClose={() => respond({ requestId: request.requestId, type: 'closed' })} title="New repo config" widthClass="max-w-lg">
      <NewRepoConfigForm
        onCreated={(configId) => respond({ requestId: request.requestId, type: 'repo-config-created', configId })}
        onCancel={() => respond({ requestId: request.requestId, type: 'closed' })}
      />
    </Modal>
  )
}

function ProviderCredentialsOverlayRenderer({
  request,
  respond,
}: {
  request: Extract<OverlayRequest, { type: 'provider-credentials' }>
  respond: (response: OverlayResponse) => void
}) {
  return (
    <ProviderCredentialsOverlay
      provider={request.provider}
      label={request.label}
      hasApiKey={request.hasApiKey}
      baseUrl={request.baseUrl}
      onClose={() => respond({ requestId: request.requestId, type: 'closed' })}
      onSaved={() => respond({ requestId: request.requestId, type: 'provider-credentials-saved' })}
    />
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
            className="w-full rounded border border-neutral-800 bg-input px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-600"
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

function CreateBookmarkOverlay({
  request,
  respond,
}: {
  request: Extract<OverlayRequest, { type: 'create-bookmark' }>
  respond: (response: OverlayResponse) => void
}) {
  const [title, setTitle] = useState(request.initialTitle?.trim() || defaultBookmarkTitle(request.initialUrl))
  const [url, setUrl] = useState(request.initialUrl)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const titleValue = title.trim()
  const urlValue = url.trim()
  const decision = urlValue ? resolveBrowserAddress(urlValue) : null
  const canSave = Boolean(titleValue && decision && decision.kind !== 'search' && decision.url && !busy)
  const origin = decision && decision.kind !== 'search' ? bookmarkOriginForUrl(decision.url) : null

  function close() {
    respond({ requestId: request.requestId, type: 'closed' })
  }

  async function submit() {
    if (!canSave || !decision || decision.kind === 'search') return
    setBusy(true)
    setError(null)
    try {
      const saved = await upsertWorkspaceBookmark(request.workspaceId, {
        title: titleValue,
        url: decision.url,
        faviconDataUrl: request.initialFaviconDataUrl ?? null,
        faviconUrl: request.initialFaviconUrl ?? null,
        createdFrom: 'browser-pane',
      })
      respond({ requestId: request.requestId, type: 'bookmark-saved', bookmarkId: saved.id })
    } catch (err) {
      setError((err as { message?: string })?.message ?? 'Bookmark save failed')
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={close} title="Save bookmark" widthClass="max-w-sm">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <label className="block space-y-1 text-xs text-neutral-400">
          <span>Title</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full rounded border border-neutral-800 bg-input px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-600"
          />
        </label>
        <label className="block space-y-1 text-xs text-neutral-400">
          <span>URL</span>
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className="w-full rounded border border-neutral-800 bg-input px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-600"
          />
        </label>
        {origin && <div className="truncate text-xs text-neutral-500">{origin.replace(/^https?:\/\//, '')}</div>}
        {urlValue && decision?.kind === 'search' && <div className="text-xs text-red-300">Enter a URL to bookmark.</div>}
        {error && <div className="text-xs text-red-300">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={close} className="rounded px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-900">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="rounded bg-neutral-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-600 disabled:opacity-50"
          >
            {busy ? 'Saving...' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

function defaultBookmarkTitle(url: string): string {
  const origin = bookmarkOriginForUrl(url)
  if (origin) return origin.replace(/^https?:\/\//, '')
  return url.trim() || 'Bookmark'
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
