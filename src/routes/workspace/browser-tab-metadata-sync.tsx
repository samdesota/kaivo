import { useEffect, useRef } from 'react'
import { workspaceTabsCollection, setWorkspaceTabBrowserMetadata } from '../../data/modules/workspace-tabs'
import { browserApi, type BrowserTabSnapshot } from '../../lib/browser-api'
import { faviconOriginForUrl } from '../../lib/favicon-cache'
import { trpc } from '../../trpc'

type NativeMetadata = Pick<BrowserTabSnapshot, 'url' | 'title' | 'favicon'>

export function BrowserTabMetadataSync() {
  const rows = workspaceTabsCollection.useRows()
  const cacheFavicon = trpc.favicon.cacheFromUrl.useMutation()
  const utils = trpc.useUtils()
  const cacheFaviconRef = useRef(cacheFavicon.mutateAsync)
  const invalidateFaviconsRef = useRef(utils.favicon.getByOrigins.invalidate)
  const eventSequenceRef = useRef(new Map<string, number>())
  const reconciledTabIdsRef = useRef(new Set<string>())
  const reconcilingTabIdsRef = useRef(new Set<string>())
  const reconciliationAttemptsRef = useRef(new Map<string, number>())
  const reconciliationTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>())
  const writeQueuesRef = useRef(new Map<string, Promise<void>>())
  const faviconQueuesRef = useRef(new Map<string, Promise<void>>())
  const enqueueMetadataRef = useRef<(browserTabId: string, metadata: Partial<NativeMetadata>) => void>(() => undefined)
  const reconcileTabRef = useRef<(browserTabId: string) => void>(() => undefined)

  cacheFaviconRef.current = cacheFavicon.mutateAsync
  invalidateFaviconsRef.current = utils.favicon.getByOrigins.invalidate

  function enqueueMetadata(browserTabId: string, metadata: Partial<NativeMetadata>) {
    const previous = writeQueuesRef.current.get(browserTabId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => applyMetadata(browserTabId, metadata))
      .catch((error) => console.warn('browser tab metadata sync failed', error))
      .finally(() => {
        if (writeQueuesRef.current.get(browserTabId) === next) writeQueuesRef.current.delete(browserTabId)
      })
    writeQueuesRef.current.set(browserTabId, next)
  }
  enqueueMetadataRef.current = enqueueMetadata

  async function applyMetadata(browserTabId: string, metadata: Partial<NativeMetadata>) {
    const row = workspaceTabsCollection.getRows().find(
      (candidate) => candidate.type === 'browser' && candidate.browserTabId === browserTabId,
    )
    if (!row) return

    const url = typeof metadata.url === 'string' ? metadata.url : row.url ?? undefined
    const title = typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title : undefined
    const faviconUrl = typeof metadata.favicon === 'string'
      ? metadata.favicon
      : typeof metadata.url === 'string' && faviconOriginForUrl(metadata.url) !== faviconOriginForUrl(row.url ?? undefined)
        ? null
        : undefined
    await setWorkspaceTabBrowserMetadata({ workspaceId: row.workspaceId, tabId: row.id, url, title, faviconUrl })

    if (typeof metadata.favicon !== 'string' || !url) return
    const origin = faviconOriginForUrl(url)
    if (!origin) return
    const previous = faviconQueuesRef.current.get(origin) ?? Promise.resolve()
    const cacheIconUrl = metadata.favicon
    const next = previous.catch(() => undefined).then(async () => {
      await cacheFaviconRef.current({ pageOrigin: origin, iconUrl: cacheIconUrl })
      await invalidateFaviconsRef.current()
    }).catch((error) => console.info('Favicon cache update failed', error)).finally(() => {
      if (faviconQueuesRef.current.get(origin) === next) faviconQueuesRef.current.delete(origin)
    })
    faviconQueuesRef.current.set(origin, next)
    await next
  }

  function scheduleReconciliationRetry(browserTabId: string) {
    const attempts = (reconciliationAttemptsRef.current.get(browserTabId) ?? 0) + 1
    reconciliationAttemptsRef.current.set(browserTabId, attempts)
    if (attempts >= 3) {
      reconciledTabIdsRef.current.add(browserTabId)
      return
    }
    const timer = setTimeout(() => {
      reconciliationTimersRef.current.delete(timer)
      reconcileTabRef.current(browserTabId)
    }, 250)
    reconciliationTimersRef.current.add(timer)
  }

  function reconcileTab(browserTabId: string) {
    if (reconciledTabIdsRef.current.has(browserTabId) || reconcilingTabIdsRef.current.has(browserTabId)) return
    reconcilingTabIdsRef.current.add(browserTabId)
    const sequence = eventSequenceRef.current.get(browserTabId) ?? 0
    void browserApi.getTab({ browserTabId }).then((snapshot) => {
      if (!snapshot || (eventSequenceRef.current.get(browserTabId) ?? 0) !== sequence) {
        scheduleReconciliationRetry(browserTabId)
        return
      }
      reconciledTabIdsRef.current.add(browserTabId)
      reconciliationAttemptsRef.current.delete(browserTabId)
      enqueueMetadataRef.current(browserTabId, snapshot)
    }).catch((error) => {
      console.info('Native browser tab metadata unavailable', error)
      scheduleReconciliationRetry(browserTabId)
    }).finally(() => {
      reconcilingTabIdsRef.current.delete(browserTabId)
    })
  }
  reconcileTabRef.current = reconcileTab

  useEffect(() => {
    if (!browserApi.isAvailable()) return
    return browserApi.onTabChange((event) => {
      eventSequenceRef.current.set(event.browserTabId, (eventSequenceRef.current.get(event.browserTabId) ?? 0) + 1)
      enqueueMetadataRef.current(event.browserTabId, nativeMetadataFromPatch(event.patch))
    })
  }, [])

  useEffect(() => {
    if (!browserApi.isAvailable()) return
    for (const row of rows) {
      const browserTabId = row.type === 'browser' ? row.browserTabId : null
      if (!browserTabId || reconciledTabIdsRef.current.has(browserTabId)) continue
      reconcileTabRef.current(browserTabId)
    }
  }, [rows])

  useEffect(() => () => {
    for (const timer of reconciliationTimersRef.current) clearTimeout(timer)
    reconciliationTimersRef.current.clear()
  }, [])

  return null
}

function nativeMetadataFromPatch(patch: Record<string, unknown>): Partial<NativeMetadata> {
  return {
    ...(typeof patch.url === 'string' ? { url: patch.url } : {}),
    ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
    ...(typeof patch.favicon === 'string' ? { favicon: patch.favicon } : {}),
  }
}
