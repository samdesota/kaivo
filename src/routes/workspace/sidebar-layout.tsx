import { useCallback, useSyncExternalStore, type ReactNode } from 'react'

type SidebarLayoutSnapshot = {
  hidden: boolean
  previewed: boolean
}

const visibleSnapshot: SidebarLayoutSnapshot = { hidden: false, previewed: false }
const hiddenSnapshot: SidebarLayoutSnapshot = { hidden: true, previewed: false }
const previewedSnapshot: SidebarLayoutSnapshot = { hidden: true, previewed: true }

let snapshot = visibleSnapshot
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function setSnapshot(next: SidebarLayoutSnapshot) {
  if (snapshot === next) return
  snapshot = next
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot() {
  return snapshot
}

export function useWorkspaceSidebarLayoutState() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const setHidden = useCallback((hidden: boolean) => setSnapshot(hidden ? hiddenSnapshot : visibleSnapshot), [])
  const toggleHidden = useCallback(() => setSnapshot(snapshot.hidden ? visibleSnapshot : hiddenSnapshot), [])
  const showPreview = useCallback(() => {
    if (snapshot.hidden) setSnapshot(previewedSnapshot)
  }, [])
  const hidePreview = useCallback(() => {
    if (snapshot.hidden) setSnapshot(hiddenSnapshot)
  }, [])

  return {
    ...current,
    setHidden,
    toggleHidden,
    showPreview,
    hidePreview,
  }
}

export function WorkspaceSidebarLayout({
  hidden,
  onShowPreview,
  onHidePreview: _onHidePreview,
  sidebar,
  children,
}: {
  hidden: boolean
  previewed: boolean
  onShowPreview: () => void
  onHidePreview: () => void
  sidebar: ReactNode
  children: ReactNode
}) {
  return (
    <div className="relative flex h-screen max-h-screen w-screen overflow-hidden bg-neutral-975 text-neutral-100">
      {hidden ? (
        <div
          className="relative z-40 h-screen w-2 shrink-0"
          onPointerEnter={() => {
            onShowPreview()
          }}
          onFocus={() => {
            onShowPreview()
          }}
          aria-label="Show sidebar"
          role="button"
          tabIndex={0}
        >
          <div className="absolute left-0 top-1/2 h-[100px] w-2 -translate-y-1/2 rounded-r-full border-y border-r border-white/10 bg-white/20 shadow-lg backdrop-blur-sm transition-colors hover:bg-white/30" />
        </div>
      ) : null}
      {!hidden ? <div className="relative z-10 h-screen max-h-screen shrink-0">{sidebar}</div> : null}
      <div className="min-w-0 flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  )
}
