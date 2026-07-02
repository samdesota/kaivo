import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  getWorkspaceSidebarOverlayTarget,
  openWorkspaceSidebarOverlay,
  subscribeWorkspaceSidebarOverlayTarget,
  type WorkspaceSidebarOverlayAction,
  type WorkspaceSidebarOverlaySession,
  type WorkspaceSidebarOverlayTarget,
} from './sidebar-overlay-controller'

export function WorkspaceSidebarOverlayShell() {
  const target = useSyncExternalStore(
    subscribeWorkspaceSidebarOverlayTarget,
    getWorkspaceSidebarOverlayTarget,
    getWorkspaceSidebarOverlayTarget,
  )
  const targetRef = useRef<WorkspaceSidebarOverlayTarget | null>(target)
  const sessionRef = useRef<WorkspaceSidebarOverlaySession | null>(null)
  const creatingRef = useRef(false)
  const lastHiddenRef = useRef<boolean | null>(target?.hidden ?? null)
  const lastPreviewedRef = useRef<boolean | null>(target?.previewed ?? null)

  useEffect(() => {
    targetRef.current = target
  }, [target])

  useEffect(() => {
    if (!target) {
      sessionRef.current?.close()
      sessionRef.current = null
      creatingRef.current = false
      return
    }
    if (!target.hidden) {
      sessionRef.current?.detach()
      return
    }
    if (sessionRef.current || creatingRef.current) return

    creatingRef.current = true
    let cancelled = false
    void openWorkspaceSidebarOverlay({
      workspaceId: target.workspaceId,
      globalTabId: target.globalTabId,
      sidebarWidth: target.sidebarWidth,
      sidebarState: target.sidebarState,
      onAction: (action: WorkspaceSidebarOverlayAction) => {
        if (action.type === 'request-state') {
          const latest = targetRef.current
          if (latest) sessionRef.current?.update({ globalTabId: latest.globalTabId, sidebarState: latest.sidebarState })
          return
        }
        targetRef.current?.onAction(action)
      },
    }).then((session) => {
      creatingRef.current = false
      if (cancelled) {
        session?.close()
        return
      }
      sessionRef.current = session
      if (targetRef.current) session?.update({ globalTabId: targetRef.current.globalTabId, sidebarState: targetRef.current.sidebarState })
      lastHiddenRef.current = targetRef.current?.hidden ?? null
      lastPreviewedRef.current = targetRef.current?.previewed ?? null
      if (targetRef.current?.previewed) void session?.showPreview({ sidebarWidth: targetRef.current.sidebarWidth })
      else void session?.showHover()
    }).catch((error) => {
      creatingRef.current = false
      console.warn('workspace sidebar overlay shell failed', error)
    })

    return () => {
      cancelled = true
    }
  }, [target?.hidden])

  useEffect(() => {
    if (!target || !sessionRef.current) return
    const wasHidden = lastHiddenRef.current
    lastHiddenRef.current = target.hidden
    if (!target.hidden) return
    sessionRef.current.update({ globalTabId: target.globalTabId, sidebarState: target.sidebarState })
    const wasPreviewed = lastPreviewedRef.current
    lastPreviewedRef.current = target.previewed
    if (target.previewed) {
      void sessionRef.current.showPreview({ sidebarWidth: target.sidebarWidth })
    } else if (wasPreviewed) {
      sessionRef.current.hidePreview()
    } else if (wasHidden === false) {
      void sessionRef.current.showHover()
    }
  }, [target?.globalTabId, target?.hidden, target?.previewed, target?.sidebarState, target?.sidebarWidth])

  useEffect(() => {
    return () => {
      sessionRef.current?.close()
      sessionRef.current = null
    }
  }, [])

  return null
}
