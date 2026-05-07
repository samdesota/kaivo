import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Horizontal split with a draggable handle. Stores the left-pane ratio in
 * localStorage under `storageKey` so the user's layout choice persists
 * per-env.
 */
export function SplitPane({
  storageKey,
  initialRatio = 0.7,
  minRatio = 0.25,
  maxRatio = 0.85,
  leftCollapsed = false,
  collapsedLeftWidth = 28,
  preferredLeftWidth,
  minRightWidth = 320,
  left,
  right,
  onRatioChange,
}: {
  storageKey: string
  initialRatio?: number
  minRatio?: number
  maxRatio?: number
  leftCollapsed?: boolean
  collapsedLeftWidth?: number
  preferredLeftWidth?: number
  minRightWidth?: number
  left: React.ReactNode
  right: React.ReactNode
  onRatioChange?: (ratio: number) => void
}) {
  const [ratio, setRatio] = useState<number>(() => {
    if (typeof window === 'undefined') return initialRatio
    const raw = window.localStorage.getItem(storageKey)
    const parsed = raw ? Number(raw) : NaN
    if (!Number.isFinite(parsed) || parsed < minRatio || parsed > maxRatio) return initialRatio
    return parsed
  })
  const [containerWidth, setContainerWidth] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(ratio))
    } catch {
      // quota / disabled storage — ignore
    }
    onRatioChange?.(ratio)
  }, [storageKey, ratio, onRatioChange])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      setContainerWidth(entry?.contentRect.width ?? 0)
    })
    observer.observe(el)
    setContainerWidth(el.getBoundingClientRect().width)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!preferredLeftWidth || !containerWidth || leftCollapsed || dragging.current) return
    const maxLeft = Math.max(0, containerWidth - minRightWidth)
    const leftWidth = Math.min(preferredLeftWidth, maxLeft)
    const next = Math.max(minRatio, Math.min(maxRatio, leftWidth / containerWidth))
    setRatio(next)
  }, [containerWidth, leftCollapsed, maxRatio, minRatio, minRightWidth, preferredLeftWidth])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) return
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left
      const next = Math.max(minRatio, Math.min(maxRatio, x / rect.width))
      setRatio(next)
    }
    function onUp() {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [minRatio, maxRatio])

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1">
      <div
        className={
          'relative flex min-h-0 min-w-0 flex-col ' +
          (!leftCollapsed ? 'border-r border-neutral-800' : '')
        }
        style={
          leftCollapsed
            ? { flex: `0 0 ${collapsedLeftWidth}px` }
            : { flex: `0 0 ${ratio * 100}%` }
        }
      >
        {left}
        {!leftCollapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={onMouseDown}
            onDoubleClick={() => setRatio(initialRatio)}
            className="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize bg-transparent hover:bg-brand-500/40"
            title="Drag to resize · double-click to reset"
          />
        )}
      </div>
      <div
        className="flex min-h-0 min-w-0 flex-col"
        style={{ flex: `1 1 0` }}
      >
        {right}
      </div>
    </div>
  )
}
