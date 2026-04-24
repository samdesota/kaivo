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
  left,
  right,
}: {
  storageKey: string
  initialRatio?: number
  minRatio?: number
  maxRatio?: number
  left: React.ReactNode
  right: React.ReactNode
}) {
  const [ratio, setRatio] = useState<number>(() => {
    if (typeof window === 'undefined') return initialRatio
    const raw = window.localStorage.getItem(storageKey)
    const parsed = raw ? Number(raw) : NaN
    if (!Number.isFinite(parsed) || parsed < minRatio || parsed > maxRatio) return initialRatio
    return parsed
  })
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, String(ratio))
    } catch {
      // quota / disabled storage — ignore
    }
  }, [storageKey, ratio])

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
        className="flex min-h-0 min-w-0 flex-col"
        style={{ flex: `0 0 calc(${ratio * 100}% - 2px)` }}
      >
        {left}
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={onMouseDown}
        onDoubleClick={() => setRatio(initialRatio)}
        className="group relative w-1 shrink-0 cursor-col-resize bg-neutral-800 hover:bg-brand-500/60"
        title="Drag to resize · double-click to reset"
      >
        <div className="pointer-events-none absolute inset-y-0 -left-1 -right-1" />
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
