import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { browserApi } from '../lib/browser-api'
import { matchBookmarks, normalizeBrowserUrl, resolveBrowserAddress, type BookmarkMatch } from '../lib/browser-navigation'
import { openBrowserUrlPopoverOverlay, openCreateBookmarkOverlay, type BrowserUrlPopoverSession } from '../lib/overlay-layer-controller'
import type { BrowserUrlPopoverResult } from '../routes/internal/overlay-layer'
import type { BookmarkRecord } from '../routes/workspace/bookmarks-store'

interface BrowserPaneProps {
  paneId: string
  workspaceId?: string
  url?: string
  title?: string
  browserTabId?: string
  active: boolean
  closeOnUnmount?: boolean
  faviconDataUrl?: string | null
  faviconUrl?: string | null
  bookmarks?: BookmarkRecord[]
  onBrowserTabId?: (browserTabId: string) => void
  onUrlChange?: (url: string) => void
  onTitleChange?: (title: string) => void
  onFaviconChange?: (input: { pageUrl: string; faviconUrl: string }) => void
  onNativeFocus?: () => void
}

const HIDDEN_RECT = { x: 0, y: 0, width: 0, height: 0 }
type BrowserSlotRect = typeof HIDDEN_RECT
type PendingBrowserTabCreate = {
  key: string
  promise: ReturnType<typeof browserApi.createTab>
  consumers: number
}

function browserSlotRectForElement(slot: HTMLElement, active: boolean): BrowserSlotRect {
  if (!active) return HIDDEN_RECT
  const rect = slot.getBoundingClientRect()
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

function sameBrowserSlotRect(a: BrowserSlotRect | null, b: BrowserSlotRect): boolean {
  return Boolean(a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)
}

type AddressResult =
  | { kind: 'bookmark'; id: string; bookmark: BookmarkRecord; match: BookmarkMatch }
  | { kind: 'search'; id: string; query: string; url: string }

export function BrowserPane({ paneId, workspaceId, url, title, browserTabId, active, closeOnUnmount = true, faviconDataUrl, faviconUrl, bookmarks = [], onBrowserTabId, onUrlChange, onTitleChange, onFaviconChange, onNativeFocus }: BrowserPaneProps) {
  const slotRef = useRef<HTMLDivElement | null>(null)
  const browserTabIdRef = useRef(browserTabId)
  const addressInputRef = useRef<HTMLInputElement | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const addressResultsRef = useRef<AddressResult[]>([])
  const addressPopoverRef = useRef<BrowserUrlPopoverSession | null>(null)
  const createdTabIdRef = useRef<string | null>(null)
  const onBrowserTabIdRef = useRef(onBrowserTabId)
  const onUrlChangeRef = useRef(onUrlChange)
  const onTitleChangeRef = useRef(onTitleChange)
  const onFaviconChangeRef = useRef(onFaviconChange)
  const onNativeFocusRef = useRef(onNativeFocus)
  const attachedTabKeyRef = useRef<string | null>(null)
  const focusedTabKeyRef = useRef<string | null>(null)
  const slotReadyRef = useRef<Promise<void>>(Promise.resolve())
  const pendingCreateRef = useRef<PendingBrowserTabCreate | null>(null)
  const findQueryRef = useRef('')
  const zoomLevelRef = useRef(0)
  const [address, setAddress] = useState(url ?? '')
  const [pageTitle, setPageTitle] = useState(title ?? '')
  const [pageFaviconUrl, setPageFaviconUrl] = useState(faviconUrl ?? null)
  const [agentConnected, setAgentConnected] = useState(false)
  const [addressFocused, setAddressFocused] = useState(false)
  const [activeAddressResult, setActiveAddressResult] = useState<number | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findMatch, setFindMatch] = useState<{ active: number; total: number } | null>(null)
  const [zoomLevel, setZoomLevel] = useState(0)

  if (browserTabId) browserTabIdRef.current = browserTabId
  onBrowserTabIdRef.current = onBrowserTabId
  onUrlChangeRef.current = onUrlChange
  onTitleChangeRef.current = onTitleChange
  onFaviconChangeRef.current = onFaviconChange
  onNativeFocusRef.current = onNativeFocus
  findQueryRef.current = findQuery
  zoomLevelRef.current = zoomLevel

  useEffect(() => {
    setAddress(url ?? '')
  }, [url])

  useEffect(() => {
    setPageTitle(title ?? '')
  }, [title])

  useEffect(() => {
    setPageFaviconUrl(faviconUrl ?? null)
  }, [faviconUrl])

  useEffect(() => {
    if (!browserApi.isAvailable()) return
    const slot = slotRef.current
    if (!slot) return
    let animationFrame = 0
    let lastRect: BrowserSlotRect | null = null

    function updateSlot() {
      const rect = browserSlotRectForElement(slot!, active)
      if (sameBrowserSlotRect(lastRect, rect)) return
      lastRect = rect
      slotReadyRef.current = browserApi.setSlot({
        paneId,
        rect,
      }).catch((error) => {
        console.info('Native browser slot update failed', error)
      })
    }

    function watchSlotPosition() {
      updateSlot()
      animationFrame = window.requestAnimationFrame(watchSlotPosition)
    }

    updateSlot()
    animationFrame = window.requestAnimationFrame(watchSlotPosition)
    const observer = new ResizeObserver(updateSlot)
    observer.observe(slot)
    window.addEventListener('resize', updateSlot)
    return () => {
      window.cancelAnimationFrame(animationFrame)
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
      if (cancelled) return
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

      const createKey = `${paneId}\0${url ?? ''}`
      let createRequest = pendingCreateRef.current
      if (!createRequest || createRequest.key !== createKey) {
        const request: PendingBrowserTabCreate = {
          key: createKey,
          promise: browserApi.createTab({ paneId, url }),
          consumers: 0,
        }
        createRequest = request
        pendingCreateRef.current = request
        void request.promise.then(
          () => {
            if (pendingCreateRef.current === request) pendingCreateRef.current = null
          },
          () => {
            if (pendingCreateRef.current === request) pendingCreateRef.current = null
          },
        )
      }

      createRequest.consumers += 1
      const tab = await createRequest.promise.finally(() => {
        createRequest.consumers -= 1
      })
      if (cancelled) {
        if (closeOnUnmount && createRequest.consumers === 0 && browserTabIdRef.current !== tab.browserTabId) {
          await browserApi.closeTab({ browserTabId: tab.browserTabId })
        }
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
  }, [active, browserTabId, closeOnUnmount, paneId, url])

  useEffect(() => {
    if (!browserApi.isAvailable()) return
    return browserApi.onTabChange((event) => {
      if (event.browserTabId !== browserTabIdRef.current) return
      const nextPageUrl = typeof event.patch.url === 'string' ? event.patch.url : address || url || ''
      if (typeof event.patch.url === 'string') {
        setAddress(event.patch.url)
        onUrlChangeRef.current?.(event.patch.url)
      }
      if (typeof event.patch.title === 'string') {
        setPageTitle(event.patch.title)
        onTitleChangeRef.current?.(event.patch.title)
      }
      if (typeof event.patch.favicon === 'string') {
        setPageFaviconUrl(event.patch.favicon)
        onFaviconChangeRef.current?.({ pageUrl: nextPageUrl, faviconUrl: event.patch.favicon })
      }
    })
  }, [address, url])

  useEffect(() => {
    if (!browserApi.isAvailable()) return
    return browserApi.onTabFocus((event) => {
      if (event.browserTabId !== browserTabIdRef.current) return
      onNativeFocusRef.current?.()
    })
  }, [paneId])

  useEffect(() => {
    if (!browserApi.isAvailable()) return
    return browserApi.onFoundInPage((event) => {
      if (event.browserTabId !== browserTabIdRef.current) return
      setFindMatch({ active: event.activeMatchOrdinal, total: event.matches })
    })
  }, [])

  useEffect(() => {
    if (!findOpen) return
    window.setTimeout(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    }, 0)
  }, [findOpen])

  useEffect(() => {
    if (!active || !browserApi.isAvailable()) return
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'f') {
        event.preventDefault()
        setFindOpen(true)
        return
      }
      if (key === '+' || key === '=') {
        event.preventDefault()
        void setBrowserZoom(zoomLevelRef.current + 0.5)
        return
      }
      if (key === '-' || key === '_') {
        event.preventDefault()
        void setBrowserZoom(zoomLevelRef.current - 0.5)
        return
      }
      if (key === '0') {
        event.preventDefault()
        void setBrowserZoom(0)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [active])

  useEffect(() => {
    if (!browserApi.isAvailable() || !browserTabId) return
    browserApi.registerTabFocusOwner({ browserTabId })
  }, [browserTabId])

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

  const activeBrowserTabId = browserTabIdRef.current
  const bookmarkableUrl = isBookmarkableBrowserUrl(address)
  const addressQuery = address.trim()
  const bookmarkMatches = addressQuery ? matchBookmarks(bookmarks, addressQuery).slice(0, 6) : []
  const addressDecision = addressQuery ? resolveBrowserAddress(addressQuery) : null
  const addressResults: AddressResult[] = [
    ...bookmarkMatches.map((match): AddressResult => ({ kind: 'bookmark', id: `bookmark:${match.bookmark.id}`, bookmark: match.bookmark, match })),
    ...(addressDecision?.kind === 'search' ? [{ kind: 'search' as const, id: `search:${addressDecision.query}`, query: addressDecision.query, url: addressDecision.url }] : []),
  ]
  addressResultsRef.current = addressResults
  const showAddressResults = addressFocused && addressQuery.length > 0 && addressResults.length > 0
  const overlayResults = addressResults.map(toBrowserUrlPopoverResult)

  useEffect(() => {
    if (!showAddressResults) {
      addressPopoverRef.current?.close()
      addressPopoverRef.current = null
      return
    }
    if (!browserApi.isAvailable()) return

    const input = addressInputRef.current
    if (!input) return
    const rect = input.getBoundingClientRect()
    const request = {
      anchor: {
        left: Math.round(rect.left),
        top: Math.round(rect.bottom + 4),
        width: Math.round(rect.width),
      },
      results: overlayResults,
      activeIndex: activeAddressResult,
    }

    if (addressPopoverRef.current) {
      addressPopoverRef.current.update(request)
      return
    }

    let cancelled = false
    void openBrowserUrlPopoverOverlay(request, (resultId) => {
      const result = addressResultsRef.current.find((candidate) => candidate.id === resultId)
      if (result) void activateAddressResult(result)
    }).then((session) => {
      if (!session) return
      if (cancelled) {
        session.close()
        return
      }
      addressPopoverRef.current = session
    })

    return () => {
      cancelled = true
    }
  }, [showAddressResults, activeAddressResult, overlayResults])

  useEffect(() => {
    return () => {
      addressPopoverRef.current?.close()
      addressPopoverRef.current = null
    }
  }, [])

  if (!browserApi.isAvailable()) {
    const fallbackUrl = url ? normalizeBrowserUrl(url) : ''
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-neutral-975 p-6 text-center text-sm text-neutral-400">
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
                className="inline-flex rounded border border-neutral-700 bg-neutral-975 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
              >
                Open externally
              </a>
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  async function openBookmarkOverlay() {
    if (!bookmarkableUrl) return
    window.localStorage?.setItem('__kaivo_bookmark_overlay_requested', bookmarkableUrl)
    await openCreateBookmarkOverlay({
      initialTitle: pageTitle || defaultBrowserBookmarkTitle(bookmarkableUrl),
      initialUrl: bookmarkableUrl,
      initialFaviconDataUrl: faviconDataUrl ?? null,
      initialFaviconUrl: pageFaviconUrl ?? null,
    })
  }

  function handleAddressKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      void openBookmarkOverlay()
      return
    }
    if (event.key === 'ArrowDown' && showAddressResults) {
      event.preventDefault()
      setActiveAddressResult((value) => value === null ? 0 : Math.min(addressResults.length - 1, value + 1))
      return
    }
    if (event.key === 'ArrowUp' && showAddressResults) {
      event.preventDefault()
      setActiveAddressResult((value) => value === null ? addressResults.length - 1 : Math.max(0, value - 1))
      return
    }
    if (event.key === 'Escape' && showAddressResults) {
      event.preventDefault()
      setActiveAddressResult(null)
      setAddressFocused(false)
    }
  }

  async function submitAddress(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!activeBrowserTabId) return
    const selected = activeAddressResult === null ? null : addressResults[activeAddressResult]
    const exactBookmark = selected ? null : matchBookmarks(bookmarks, address).find((match) => match.reason === 'exact')?.bookmark
    const nextUrl = selected?.kind === 'bookmark'
      ? selected.bookmark.url
      : selected?.kind === 'search'
        ? selected.url
        : exactBookmark?.url ?? normalizeBrowserUrl(address)
    setAddressFocused(false)
    setActiveAddressResult(null)
    setAddress(nextUrl)
    await browserApi.navigate({ browserTabId: activeBrowserTabId, url: nextUrl })
  }

  async function activateAddressResult(result: AddressResult) {
    if (!activeBrowserTabId) return
    const nextUrl = result.kind === 'bookmark' ? result.bookmark.url : result.url
    setAddressFocused(false)
    setActiveAddressResult(null)
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

  async function runFind(nextQuery: string, options?: { forward?: boolean; findNext?: boolean }) {
    if (!activeBrowserTabId) return
    if (!nextQuery) {
      setFindMatch(null)
      await browserApi.stopFindInPage({ browserTabId: activeBrowserTabId, action: 'clearSelection' })
      return
    }
    await browserApi.findInPage({
      browserTabId: activeBrowserTabId,
      text: nextQuery,
      forward: options?.forward ?? true,
      findNext: options?.findNext ?? false,
    })
  }

  async function closeFind() {
    setFindOpen(false)
    setFindMatch(null)
    if (!activeBrowserTabId) return
    await browserApi.stopFindInPage({ browserTabId: activeBrowserTabId, action: 'keepSelection' })
  }

  async function setBrowserZoom(nextZoomLevel: number) {
    const targetTabId = browserTabIdRef.current
    if (!targetTabId) return
    const result = await browserApi.setZoom({ browserTabId: targetTabId, level: nextZoomLevel })
    setZoomLevel(result.zoomLevel)
  }

  function handleFindKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      void closeFind()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      void runFind(findQueryRef.current, { forward: !event.shiftKey, findNext: true })
    }
  }

  async function disconnectAgent() {
    if (!activeBrowserTabId) return
    await browserApi.disconnectAgent({ browserTabId: activeBrowserTabId })
    setAgentConnected(false)
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-975">
      <form
        onSubmit={submitAddress}
        className="flex shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-975 px-2 py-1.5"
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
        <label className="sr-only" htmlFor={`browser-url-${paneId}`}>
          URL
        </label>
        <div className="relative ml-1 min-w-0 flex-1">
          <input
            ref={addressInputRef}
            id={`browser-url-${paneId}`}
            value={address}
            onChange={(event) => {
              setAddressFocused(true)
              setAddress(event.currentTarget.value)
              setActiveAddressResult(null)
            }}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => window.setTimeout(() => setAddressFocused(false), 100)}
            onKeyDown={handleAddressKeyDown}
            placeholder="Search bookmarks or enter URL"
            className="w-full rounded-md border border-neutral-800 bg-input px-2 py-1 text-xs text-neutral-100 outline-none placeholder:text-placeholder focus:border-neutral-600"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>
        <BrowserControlButton
          label="Open DevTools"
          disabled={!activeBrowserTabId}
          onClick={() => void openDevTools()}
        >
          &lt;/&gt;
        </BrowserControlButton>
        <BrowserControlButton
          label="Bookmark page"
          disabled={!bookmarkableUrl}
          onClick={() => void openBookmarkOverlay()}
        >
          ☆
        </BrowserControlButton>
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
      {findOpen ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-300">
          <label className="sr-only" htmlFor={`browser-find-${paneId}`}>Find in page</label>
          <input
            ref={findInputRef}
            id={`browser-find-${paneId}`}
            value={findQuery}
            onChange={(event) => {
              const nextQuery = event.currentTarget.value
              setFindQuery(nextQuery)
              void runFind(nextQuery)
            }}
            onKeyDown={handleFindKeyDown}
            placeholder="Find in page"
            className="w-56 rounded-md border border-neutral-800 bg-input px-2 py-1 text-xs text-neutral-100 outline-none placeholder:text-placeholder focus:border-neutral-600"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <span className="min-w-12 text-right text-neutral-500">
            {findQuery ? `${findMatch?.active ?? 0}/${findMatch?.total ?? 0}` : ''}
          </span>
          <BrowserControlButton
            label="Previous match"
            disabled={!activeBrowserTabId || !findQuery}
            onClick={() => void runFind(findQuery, { forward: false, findNext: true })}
          >
            ↑
          </BrowserControlButton>
          <BrowserControlButton
            label="Next match"
            disabled={!activeBrowserTabId || !findQuery}
            onClick={() => void runFind(findQuery, { forward: true, findNext: true })}
          >
            ↓
          </BrowserControlButton>
          <BrowserControlButton
            label="Close find"
            disabled={false}
            onClick={() => void closeFind()}
          >
            ×
          </BrowserControlButton>
        </div>
      ) : null}
      <div ref={slotRef} className="min-h-0 flex-1 bg-neutral-975" aria-label="Browser pane slot" />
    </div>
  )
}

function toBrowserUrlPopoverResult(result: AddressResult): BrowserUrlPopoverResult {
  if (result.kind === 'search') {
    return { id: result.id, kind: 'search', title: `Search web for "${result.query}"` }
  }

  return {
    id: result.id,
    kind: 'bookmark',
    title: result.bookmark.title,
    detail: result.bookmark.origin?.replace(/^https?:\/\//, '') ?? result.bookmark.url,
    iconUrl: result.bookmark.faviconDataUrl ?? result.bookmark.faviconUrl,
  }
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

export { normalizeBrowserUrl } from '../lib/browser-navigation'

export function isBookmarkableBrowserUrl(raw: string | undefined): string | null {
  const decision = resolveBrowserAddress(raw ?? '')
  if (decision.kind === 'search') return null
  if (decision.url === 'about:blank') return null
  if (!/^https?:\/\//i.test(decision.url)) return null
  return decision.url
}

function defaultBrowserBookmarkTitle(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
