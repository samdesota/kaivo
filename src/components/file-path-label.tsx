import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface VisiblePathParts {
  prefixCount: number
  suffixCount: number
  truncated: boolean
}

export function FilePathLabel({ path }: { path: string }) {
  const parts = useMemo(() => path.split('/').filter(Boolean), [path])
  const containerRef = useRef<HTMLSpanElement | null>(null)
  const measureRef = useRef<HTMLSpanElement | null>(null)
  const [visible, setVisible] = useState<VisiblePathParts | null>(null)
  const [tooltip, setTooltip] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    function updateVisibleParts() {
      const container = containerRef.current
      const measure = measureRef.current
      if (!container || !measure) return

      const available = container.clientWidth
      if (available <= 0 || parts.length === 0) {
        const fallback = fallbackVisibleParts(parts)
        setVisible((current) => sameVisibleParts(current, fallback) ? current : fallback)
        return
      }

      const segmentWidths = Array.from(measure.querySelectorAll<HTMLElement>('[data-segment]')).map(measuredWidth)
      const slashWidth = measuredWidth(measure.querySelector<HTMLElement>('[data-slash]'))
      const ellipsisWidth = measuredWidth(measure.querySelector<HTMLElement>('[data-ellipsis]'))
      const fullWidth = segmentWidths.reduce((sum, width) => sum + width, 0) + slashWidth * Math.max(parts.length - 1, 0)
      if (fullWidth <= available) {
        setVisible((current) => current?.truncated === false && current.prefixCount === parts.length ? current : { prefixCount: parts.length, suffixCount: 0, truncated: false })
        return
      }

      let best: VisiblePathParts = { prefixCount: 0, suffixCount: 1, truncated: true }
      for (let prefixCount = Math.min(2, parts.length - 1); prefixCount >= 0; prefixCount--) {
        const maxSuffix = parts.length - prefixCount - 1
        for (let suffixCount = maxSuffix; suffixCount >= 1; suffixCount--) {
          const width = truncatedWidth(segmentWidths, slashWidth, ellipsisWidth, prefixCount, suffixCount)
          if (width <= available) {
            best = { prefixCount, suffixCount, truncated: true }
            setVisible((current) => sameVisibleParts(current, best) ? current : best)
            return
          }
        }
      }
      setVisible((current) => sameVisibleParts(current, best) ? current : best)
    }

    updateVisibleParts()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(updateVisibleParts)
    if (containerRef.current) observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [path, parts])

  const display = visible ?? fallbackVisibleParts(parts)
  const prefix = display.truncated ? parts.slice(0, display.prefixCount) : parts
  const suffix = display.truncated ? parts.slice(Math.max(parts.length - display.suffixCount, display.prefixCount)) : []
  const hiddenPath = display.truncated ? parts.slice(display.prefixCount, Math.max(parts.length - display.suffixCount, display.prefixCount)).join('/') : ''

  return (
    <span ref={containerRef} className="relative block min-w-0 overflow-hidden whitespace-nowrap" title={path}>
      <span className={visible ? 'flex min-w-0 items-center overflow-hidden' : 'invisible flex min-w-0 items-center overflow-hidden'}>
        {display.truncated ? (
          <>
            <PathSegments parts={prefix} />
            {prefix.length > 0 && <PathSlash />}
            <span
              className="shrink-0 cursor-default"
              onPointerEnter={(event) => setTooltipPosition(event.currentTarget, setTooltip)}
              onPointerLeave={() => setTooltip(null)}
              onFocus={(event) => setTooltipPosition(event.currentTarget, setTooltip)}
              onBlur={() => setTooltip(null)}
              tabIndex={0}
            >
              ...
            </span>
            {suffix.length > 0 && <PathSlash />}
            <PathSegments parts={suffix} />
          </>
        ) : (
          <PathSegments parts={prefix} />
        )}
      </span>
      <span ref={measureRef} className="pointer-events-none absolute left-0 top-0 -z-10 flex whitespace-nowrap opacity-0" aria-hidden="true">
        {parts.map((part, index) => <span key={`${part}-${index}`} data-segment>{part}</span>)}
        <span data-slash className="px-1">/</span>
        <span data-ellipsis>...</span>
      </span>
      {tooltip && hiddenPath && typeof document !== 'undefined' && createPortal(
        <div
          className="pointer-events-none fixed z-[10000] -translate-x-1/2 whitespace-nowrap rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-200 shadow-xl"
          style={{ left: tooltip.left, top: tooltip.top }}
          role="tooltip"
        >
          {hiddenPath}
        </div>,
        document.body,
      )}
    </span>
  )
}

function PathSegments({ parts }: { parts: string[] }) {
  return parts.map((part, index) => (
    <span key={`${part}-${index}`} className="shrink-0">
      {index > 0 && <PathSlash />}
      {part}
    </span>
  ))
}

function PathSlash() {
  return <span className="px-1 shrink-0 text-neutral-600">/</span>
}

function measuredWidth(node: HTMLElement | null): number {
  return node?.offsetWidth ?? 0
}

function truncatedWidth(segmentWidths: number[], slashWidth: number, ellipsisWidth: number, prefixCount: number, suffixCount: number): number {
  const prefixWidth = segmentWidths.slice(0, prefixCount).reduce((sum, width) => sum + width, 0)
  const suffixWidth = segmentWidths.slice(Math.max(segmentWidths.length - suffixCount, prefixCount)).reduce((sum, width) => sum + width, 0)
  const separators = Math.max(prefixCount - 1, 0) + Math.max(suffixCount - 1, 0) + (prefixCount > 0 ? 1 : 0) + (suffixCount > 0 ? 1 : 0)
  return prefixWidth + suffixWidth + ellipsisWidth + slashWidth * separators
}

function sameVisibleParts(a: VisiblePathParts | null, b: VisiblePathParts): boolean {
  return !!a && a.prefixCount === b.prefixCount && a.suffixCount === b.suffixCount && a.truncated === b.truncated
}

function setTooltipPosition(node: HTMLElement, setTooltip: (position: { left: number; top: number }) => void) {
  const rect = node.getBoundingClientRect()
  setTooltip({ left: rect.left + rect.width / 2, top: rect.bottom + 8 })
}

function fallbackVisibleParts(parts: string[]): VisiblePathParts {
  if (parts.length <= 5) return { prefixCount: parts.length, suffixCount: 0, truncated: false }
  return { prefixCount: 2, suffixCount: 2, truncated: true }
}
