import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

const STICK_TO_BOTTOM_THRESHOLD = 80

interface BottomAnchoredLazyListProps<T> {
  items: T[]
  itemKey: (item: T, index: number) => string
  renderItem: (item: T, index: number, isLast: boolean) => ReactNode
  resetKey: string
  pageSize?: number
  topLoadThreshold?: number
}

export function BottomAnchoredLazyList<T>({
  items,
  itemKey,
  renderItem,
  resetKey,
  pageSize = 80,
  topLoadThreshold = 160,
}: BottomAnchoredLazyListProps<T>) {
  const [visibleCount, setVisibleCount] = useState(() => Math.min(pageSize, items.length))
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  const initialBottomDone = useRef(false)
  const previousItemsLength = useRef(items.length)
  const pendingPrependScrollHeight = useRef<number | null>(null)
  const lastScrollTop = useRef(0)
  const lastScrollHeight = useRef(0)

  const recordScrollState = useCallback((el: HTMLDivElement) => {
    lastScrollTop.current = el.scrollTop
    lastScrollHeight.current = el.scrollHeight
  }, [])

  useLayoutEffect(() => {
    setVisibleCount(Math.min(pageSize, items.length))
    stickToBottom.current = true
    initialBottomDone.current = false
    previousItemsLength.current = items.length
    pendingPrependScrollHeight.current = null
  }, [pageSize, resetKey])

  useLayoutEffect(() => {
    const previousLength = previousItemsLength.current
    const delta = items.length - previousLength
    previousItemsLength.current = items.length

    if (delta > 0 && !stickToBottom.current) {
      setVisibleCount((count) => Math.min(items.length, count + delta))
    } else if (delta > 0) {
      setVisibleCount((count) => Math.min(items.length, Math.max(count, Math.min(pageSize, items.length))))
    } else if (delta < 0) {
      setVisibleCount((count) => Math.min(items.length, count))
    }
  }, [items.length])

  const visibleStart = Math.max(0, items.length - visibleCount)
  const visibleItems = useMemo(
    () => items.slice(visibleStart),
    [items, visibleStart],
  )

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    recordScrollState(el)
  }, [recordScrollState])

  useLayoutEffect(() => {
    const before = pendingPrependScrollHeight.current
    if (before === null) return
    pendingPrependScrollHeight.current = null

    const el = scrollRef.current
    if (!el) return
    el.scrollTop += el.scrollHeight - before
  }, [visibleCount, visibleItems.length])

  useLayoutEffect(() => {
    if (visibleItems.length === 0) return
    if (!initialBottomDone.current || stickToBottom.current) {
      scrollToBottom()
      initialBottomDone.current = true
    }
  }, [scrollToBottom, visibleItems.length, items.length])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    function onScroll() {
      const target = el!
      const atBottom = target.scrollHeight - target.scrollTop - target.clientHeight < STICK_TO_BOTTOM_THRESHOLD
      const contentGrew = target.scrollHeight > lastScrollHeight.current
      const scrolledUp = target.scrollTop < lastScrollTop.current

      if (stickToBottom.current && contentGrew && !scrolledUp) {
        scrollToBottom()
      } else {
        stickToBottom.current = atBottom
        recordScrollState(target)
      }

      if (target.scrollTop > topLoadThreshold || visibleCount >= items.length) return
      pendingPrependScrollHeight.current = target.scrollHeight
      setVisibleCount((count) => Math.min(items.length, count + pageSize))
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [items.length, pageSize, recordScrollState, scrollToBottom, topLoadThreshold, visibleCount])

  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content || typeof ResizeObserver === 'undefined') return

    const resizeObserver = new ResizeObserver(() => {
      if (stickToBottom.current) scrollToBottom()
    })
    resizeObserver.observe(el)
    resizeObserver.observe(content)
    return () => resizeObserver.disconnect()
  }, [scrollToBottom, visibleItems.length])

  return (
    <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
      <div ref={contentRef} className="min-w-0 w-full">
        {visibleStart > 0 && (
          <div className="flex justify-center px-4 py-3">
            <button
              type="button"
              onClick={() => {
                const el = scrollRef.current
                if (el) pendingPrependScrollHeight.current = el.scrollHeight
                setVisibleCount((count) => Math.min(items.length, count + pageSize))
              }}
              className="rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-[10px] uppercase tracking-wide text-neutral-500 hover:border-neutral-700 hover:text-neutral-300"
            >
              Load older messages
            </button>
          </div>
        )}
        {visibleItems.map((item, offset) => {
          const index = visibleStart + offset
          return <div key={itemKey(item, index)} className="min-w-0">{renderItem(item, index, index === items.length - 1)}</div>
        })}
      </div>
    </div>
  )
}
