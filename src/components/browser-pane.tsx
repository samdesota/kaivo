import { useEffect, useRef } from 'react'
import { browserApi } from '../lib/browser-api'

interface BrowserPaneProps {
  paneId: string
  url?: string
  browserTabId?: string
  active: boolean
  onBrowserTabId?: (browserTabId: string) => void
}

const HIDDEN_RECT = { x: 0, y: 0, width: 0, height: 0 }

export function BrowserPane({ paneId, url, browserTabId, active, onBrowserTabId }: BrowserPaneProps) {
  const slotRef = useRef<HTMLDivElement | null>(null)
  const browserTabIdRef = useRef(browserTabId)
  const createdTabIdRef = useRef<string | null>(null)

  browserTabIdRef.current = browserTabId

  useEffect(() => {
    if (!browserApi.isAvailable()) return
    const slot = slotRef.current
    if (!slot) return

    function updateSlot() {
      const rect = active ? slot!.getBoundingClientRect() : HIDDEN_RECT
      void browserApi.setSlot({
        paneId,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      })
    }

    updateSlot()
    const observer = new ResizeObserver(updateSlot)
    observer.observe(slot)
    window.addEventListener('resize', updateSlot)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateSlot)
      void browserApi.setSlot({ paneId, rect: HIDDEN_RECT })
    }
  }, [active, paneId])

  useEffect(() => {
    if (!active || !browserApi.isAvailable()) return
    let cancelled = false

    async function ensureTab() {
      const existingTabId = browserTabIdRef.current
      if (existingTabId) {
        await browserApi.attachTab({ paneId, browserTabId: existingTabId })
        await browserApi.focusTab({ browserTabId: existingTabId })
        return
      }

      const tab = await browserApi.createTab({ paneId, url })
      if (cancelled) {
        await browserApi.closeTab({ browserTabId: tab.browserTabId })
        return
      }
      createdTabIdRef.current = tab.browserTabId
      browserTabIdRef.current = tab.browserTabId
      onBrowserTabId?.(tab.browserTabId)
    }

    void ensureTab()
    return () => {
      cancelled = true
    }
  }, [active, onBrowserTabId, paneId, url])

  useEffect(() => {
    return () => {
      const ownedTabId = browserTabIdRef.current ?? createdTabIdRef.current
      if (ownedTabId && browserApi.isAvailable()) {
        void browserApi.closeTab({ browserTabId: ownedTabId })
      }
    }
  }, [])

  if (!browserApi.isAvailable()) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center bg-neutral-950 p-6 text-center text-sm text-neutral-400">
        <div>
          <div className="mb-2 text-neutral-200">Browser pane unavailable</div>
          <div>Open this workspace in the desktop app to use native browser tabs.</div>
        </div>
      </div>
    )
  }

  return (
    <div ref={slotRef} className="h-full min-h-0 bg-neutral-950" aria-label="Browser pane slot" />
  )
}
