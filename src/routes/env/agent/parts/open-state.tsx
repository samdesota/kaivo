import { createContext, useContext, useMemo, useRef, useSyncExternalStore } from 'react'

/**
 * Open/closed state for collapsible rows, lifted out of the row component
 * itself. The virtualizer unmounts off-screen rows; if state lives inside
 * the row, scrolling makes it forget its size and the layout shifts as
 * heights re-measure. Holding it above the virtualizer keeps heights stable
 * across remounts.
 */

interface OpenStore {
  read: (id: string, fallback: boolean) => boolean
  write: (id: string, open: boolean) => void
  subscribe: (id: string, cb: () => void) => () => void
}

function createOpenStore(): OpenStore {
  const map = new Map<string, boolean>()
  const subs = new Map<string, Set<() => void>>()
  return {
    read(id, fallback) {
      const v = map.get(id)
      return v === undefined ? fallback : v
    },
    write(id, open) {
      if (map.get(id) === open) return
      map.set(id, open)
      const set = subs.get(id)
      if (set) for (const fn of set) fn()
    },
    subscribe(id, cb) {
      let s = subs.get(id)
      if (!s) {
        s = new Set()
        subs.set(id, s)
      }
      s.add(cb)
      return () => {
        s!.delete(cb)
        if (s!.size === 0) subs.delete(id)
      }
    },
  }
}

const Ctx = createContext<OpenStore | null>(null)

export function OpenStateProvider({ children }: { children: React.ReactNode }) {
  const store = useRef<OpenStore | null>(null)
  if (!store.current) store.current = createOpenStore()
  return <Ctx.Provider value={store.current}>{children}</Ctx.Provider>
}

export function useOpenState(
  id: string,
  defaultOpen: boolean,
): [boolean, (v: boolean | ((prev: boolean) => boolean)) => void] {
  const ctx = useContext(Ctx)
  const fallback = useRef<OpenStore | null>(null)
  if (!ctx && !fallback.current) fallback.current = createOpenStore()
  const store = ctx ?? fallback.current!

  const open = useSyncExternalStore(
    useMemo(() => (cb: () => void) => store.subscribe(id, cb), [store, id]),
    () => store.read(id, defaultOpen),
    () => defaultOpen,
  )
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? (v as (p: boolean) => boolean)(open) : v
    store.write(id, next)
  }
  return [open, setOpen]
}
