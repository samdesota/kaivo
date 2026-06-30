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
      onAction: (action: WorkspaceSidebarOverlayAction) => targetRef.current?.onAction(action),
    }).then((session) => {
      creatingRef.current = false
      if (cancelled) {
        session?.close()
        return
      }
      sessionRef.current = session
      if (targetRef.current?.previewed) void session?.attach({ sidebarWidth: targetRef.current.sidebarWidth })
    }).catch((error) => {
      creatingRef.current = false
      console.warn('workspace sidebar overlay shell failed', error)
    })

    return () => {
      cancelled = true
    }
  }, [target?.hidden])

  useEffect(() => {
    if (!target?.hidden || !sessionRef.current) return
    if (target.previewed) void sessionRef.current.attach({ sidebarWidth: target.sidebarWidth })
    else sessionRef.current.detach()
  }, [target?.hidden, target?.previewed, target?.sidebarWidth])

  useEffect(() => {
    return () => {
      sessionRef.current?.close()
      sessionRef.current = null
    }
  }, [])

  return null
}
