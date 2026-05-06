import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { browserApi } from '../lib/browser-api'

interface BrowserPaneProps {
  paneId: string
  url?: string
  browserTabId?: string
  active: boolean
  closeOnUnmount?: boolean
  onBrowserTabId?: (browserTabId: string) => void
  onTitleChange?: (title: string) => void
}

const HIDDEN_RECT = { x: 0, y: 0, width: 0, height: 0 }

export function BrowserPane({ paneId, url, browserTabId, active, closeOnUnmount = true, onBrowserTabId, onTitleChange }: BrowserPaneProps) {
  const slotRef = useRef<HTMLDivElement | null>(null)
  const browserTabIdRef = useRef(browserTabId)
  const createdTabIdRef = useRef<string | null>(null)
  const onBrowserTabIdRef = useRef(onBrowserTabId)
  const onTitleChangeRef = useRef(onTitleChange)
  const attachedTabKeyRef = useRef<string | null>(null)
  const focusedTabKeyRef = useRef<string | null>(null)
  const slotReadyRef = useRef<Promise<void>>(Promise.resolve())
  const [address, setAddress] = useState(url ?? '')
  const [agentConnected, setAgentConnected] = useState(false)

  browserTabIdRef.current = browserTabId
  onBrowserTabIdRef.current = onBrowserTabId
  onTitleChangeRef.current = onTitleChange

  useEffect(() => {
    setAddress(url ?? '')
  }, [url])

  useEffect(() => {
    if (!browserApi.isAvailable()) return
    const slot = slotRef.current
    if (!slot) return

    function updateSlot() {
      const rect = active ? slot!.getBoundingClientRect() : HIDDEN_RECT
      slotReadyRef.current = browserApi.setSlot({
        paneId,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }).catch((error) => {
        console.info('Native browser slot update failed', error)
      })
    }

    updateSlot()
    const observer = new ResizeObserver(updateSlot)
    observer.observe(slot)
    window.addEventListener('resize', updateSlot)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateSlot)
      void browserApi.setSlot({ paneId, rect: HIDDEN_RECT }).catch((error) => {
        console.info('Native browser slot cleanup failed', error)
      })
    }
  }, [active, paneId])

  useEffect(() => {
    if (!active || !browserApi.isAvailable()) {
      focusedTabKeyRef.current = null
      return
    }
    let cancelled = false

    async function ensureTab() {
      await slotReadyRef.current
      const existingTabId = browserTabIdRef.current
      if (existingTabId) {
        const tabKey = `${existingTabId}:${paneId}`
        try {
          if (attachedTabKeyRef.current !== tabKey) {
            await browserApi.attachTab({ paneId, browserTabId: existingTabId })
            attachedTabKeyRef.current = tabKey
            focusedTabKeyRef.current = null
          }
          if (focusedTabKeyRef.current !== tabKey) {
            await browserApi.focusTab({ browserTabId: existingTabId })
            focusedTabKeyRef.current = tabKey
          }
          return
        } catch {
          if (cancelled) return
          browserTabIdRef.current = undefined
          attachedTabKeyRef.current = null
          focusedTabKeyRef.current = null
        }
      }

      const tab = await browserApi.createTab({ paneId, url })
      if (cancelled) {
        await browserApi.closeTab({ browserTabId: tab.browserTabId })
        return
      }
      createdTabIdRef.current = tab.browserTabId
      browserTabIdRef.current = tab.browserTabId
      attachedTabKeyRef.current = `${tab.browserTabId}:${paneId}`
      focusedTabKeyRef.current = `${tab.browserTabId}:${paneId}`
      onBrowserTabIdRef.current?.(tab.browserTabId)
    }

    void ensureTab()
    return () => {
      cancelled = true
    }
  }, [active, browserTabId, paneId, url])

  useEffect(() => {
    if (!browserApi.isAvailable()) return
    return browserApi.onTabChange((event) => {
      if (event.browserTabId !== browserTabIdRef.current) return
      if (typeof event.patch.url === 'string') setAddress(event.patch.url)
      if (typeof event.patch.title === 'string') onTitleChangeRef.current?.(event.patch.title)
    })
  }, [])

  useEffect(() => {
    if (!browserApi.isAvailable()) return
    let cancelled = false
    async function refresh() {
      const id = browserTabIdRef.current
      if (!id) {
        if (!cancelled) setAgentConnected(false)
        return
      }
      const connections = await browserApi.getAgentConnections()
      if (!cancelled) setAgentConnected(connections.browserTabIds.includes(id))
    }
    void refresh()
    const interval = window.setInterval(() => void refresh(), 1000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [browserTabId])

  useEffect(() => {
    return () => {
      if (!closeOnUnmount) return
      const ownedTabId = browserTabIdRef.current ?? createdTabIdRef.current
      if (ownedTabId && browserApi.isAvailable()) {
        void browserApi.closeTab({ browserTabId: ownedTabId }).catch((error) => {
          console.info('Native browser tab cleanup failed', error)
        })
      }
    }
  }, [closeOnUnmount])

  if (!browserApi.isAvailable()) {
    const fallbackUrl = url ? normalizeBrowserUrl(url) : ''
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-neutral-950 p-6 text-center text-sm text-neutral-400">
        <div className="max-w-md">
          <div className="mb-2 text-neutral-200">Browser pane unavailable</div>
          <div>Native browser tabs require the desktop app. This URL can still be opened from browser mode.</div>
          {fallbackUrl ? (
            <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 text-left">
              <div className="mb-2 break-all font-mono text-xs text-neutral-300">{fallbackUrl}</div>
              <a
                href={fallbackUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
              >
                Open externally
              </a>
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  const activeBrowserTabId = browserTabIdRef.current

  async function submitAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeBrowserTabId) return
    const nextUrl = normalizeBrowserUrl(address)
    setAddress(nextUrl)
    await browserApi.navigate({ browserTabId: activeBrowserTabId, url: nextUrl })
  }

  async function runNavigation(action: 'back' | 'forward' | 'reload') {
    if (!activeBrowserTabId) return
    if (action === 'back') await browserApi.back({ browserTabId: activeBrowserTabId })
    else if (action === 'forward') await browserApi.forward({ browserTabId: activeBrowserTabId })
    else await browserApi.reload({ browserTabId: activeBrowserTabId })
  }

  async function openDevTools() {
    if (!activeBrowserTabId) return
    await browserApi.openDevTools({ browserTabId: activeBrowserTabId })
  }

  async function disconnectAgent() {
    if (!activeBrowserTabId) return
    await browserApi.disconnectAgent({ browserTabId: activeBrowserTabId })
    setAgentConnected(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950">
      <form
        onSubmit={submitAddress}
        className="flex shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-950/95 px-2 py-1.5"
        aria-label="Browser controls"
      >
        <BrowserControlButton
          label="Back"
          disabled={!activeBrowserTabId}
          onClick={() => void runNavigation('back')}
        >
          ←
        </BrowserControlButton>
        <BrowserControlButton
          label="Forward"
          disabled={!activeBrowserTabId}
          onClick={() => void runNavigation('forward')}
        >
          →
        </BrowserControlButton>
        <BrowserControlButton
          label="Reload"
          disabled={!activeBrowserTabId}
          onClick={() => void runNavigation('reload')}
        >
          ↻
        </BrowserControlButton>
        <BrowserControlButton
          label="Open DevTools"
          disabled={!activeBrowserTabId}
          onClick={() => void openDevTools()}
        >
          DevTools
        </BrowserControlButton>
        <label className="sr-only" htmlFor={`browser-url-${paneId}`}>
          URL
        </label>
        <input
          id={`browser-url-${paneId}`}
          value={address}
          onChange={(event) => setAddress(event.currentTarget.value)}
          placeholder="Search or enter URL"
          className="ml-1 min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-brand-500"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </form>
      {agentConnected ? (
        <div className="flex shrink-0 items-center justify-between border-b border-amber-500/30 bg-amber-950/50 px-3 py-1.5 text-xs text-amber-100">
          <span>Agent connected to this tab</span>
          <button
            type="button"
            onClick={() => void disconnectAgent()}
            className="rounded border border-amber-400/40 px-2 py-0.5 text-amber-50 hover:bg-amber-900"
          >
            Disconnect
          </button>
        </div>
      ) : null}
      <div ref={slotRef} className="min-h-0 flex-1 bg-neutral-950" aria-label="Browser pane slot" />
    </div>
  )
}

function BrowserControlButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 text-sm text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

export function normalizeBrowserUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'about:blank'
  if (trimmed.startsWith('localhost') || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?/.test(trimmed)) {
    return `http://${trimmed}`
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return trimmed
  return `https://${trimmed}`
}
