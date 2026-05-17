import { useLayoutEffect, useMemo } from 'react'
import { paneTabIconForType } from '../../../../components/tab-icon'
import { browserTabIconForUrl, faviconOriginForUrl, type FaviconCacheRecord } from '../../../../lib/favicon-cache'
import { trpc } from '../../../../trpc'
import { UniversalMenuResultList, selectResult } from '../shared'
import type { UniversalMenuContextItem, UniversalMenuResult, UniversalScopeModule, UniversalScopeProps } from '../types'
import { disabledRow, webQueryUrl } from '../utils'
import type { PaneContent } from '../../shell/tab-state'

export const webScopeModule: UniversalScopeModule = {
  id: 'web',
  label: 'Web',
  key: '@',
  detail: 'Search tabs and bookmarks',
  placeholder: 'Web search lands in Task 7',
  Component: WebScope,
}

export function WebScope(props: UniversalScopeProps) {
  const { activeIndex, contextItems, mouseMoved, onActiveChange, onClose, onMouseMoved, onOpenContent, query, setScopeApi } = props
  const faviconOrigins = useMemo(() => Array.from(new Set(contextItems.filter((item) => item.kind === 'browser-tab' && item.content.type === 'browser').map((item) => item.content.type === 'browser' ? faviconOriginForUrl(item.content.url) : null).filter((origin): origin is string => Boolean(origin)))), [contextItems])
  const faviconCache = trpc.favicon.getByOrigins.useQuery({ origins: faviconOrigins }, { enabled: faviconOrigins.length > 0, staleTime: 60_000 })
  const results = useMemo(() => webScopeResults({ items: contextItems, query, faviconRecords: (faviconCache.data ?? {}) as Record<string, FaviconCacheRecord>, openContent: (content) => onOpenContent?.(content) }), [contextItems, faviconCache.data, onOpenContent, query])

  useLayoutEffect(() => {
    setScopeApi({ resultCount: results.length, selectActive: (event) => selectResult(results, activeIndex, onClose, event) })
  }, [activeIndex, onClose, results, setScopeApi])

  return <UniversalMenuResultList results={results} activeIndex={activeIndex} mouseMoved={mouseMoved} onMouseMoved={onMouseMoved} onActiveChange={onActiveChange} onSelect={(index, event) => void selectResult(results, index, onClose, event)} loading={faviconCache.isFetching} />
}

function webScopeResults({ items, query, faviconRecords, openContent }: { items: UniversalMenuContextItem[]; query: string; faviconRecords: Record<string, FaviconCacheRecord>; openContent: (content: PaneContent) => void }): UniversalMenuResult[] {
  const q = query.trim().toLowerCase()
  const directUrl = webQueryUrl(query)
  const rows: UniversalMenuResult[] = []
  if (directUrl) {
    rows.push({ id: `web-url:${directUrl}`, kind: 'browser-tab', label: directUrl, detail: 'open URL', icon: browserTabIconForUrl({ url: directUrl, records: faviconRecords }), haystack: directUrl, run: () => openContent({ type: 'browser', url: directUrl }) })
  }
  rows.push(...items.filter((item) => item.kind === 'browser-tab').filter((item) => !q || `${item.label} ${item.detail ?? ''}`.toLowerCase().includes(q)).map((item): UniversalMenuResult => ({
    id: item.id,
    kind: 'browser-tab',
    label: item.label,
    detail: item.detail,
    icon: item.content.type === 'browser' ? browserTabIconForUrl({ url: item.content.url, records: faviconRecords }) : paneTabIconForType('browser'),
    haystack: `${item.label} ${item.detail ?? ''}`,
    run: () => openContent(item.content),
  })))
  return rows.length ? rows : [disabledRow('web-empty', q ? 'No matching tabs or URLs.' : 'No browser tabs are open.')]
}
