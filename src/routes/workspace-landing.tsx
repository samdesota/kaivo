import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { trpc } from '../trpc'
import { chooseWorkspaceLandingAction } from './workspace-landing-state'
import { clientLogger } from '../lib/client-logger'

const log = clientLogger.diagnostic('workspace-landing')

export function WorkspaceLandingPage() {
  const navigate = useNavigate()
  const list = trpc.workspace.list.useQuery()
  const create = trpc.workspace.create.useMutation()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    const action = chooseWorkspaceLandingAction(list.isLoading, list.data)
    log.info('landing action evaluated', {
      action: action.type,
      isLoading: list.isLoading,
      isError: list.isError,
      error: list.error instanceof Error ? list.error.message : list.error ? String(list.error) : null,
      workspaceCount: list.data?.length ?? null,
    })
    if (action.type === 'wait') return
    started.current = true
    if (action.type === 'open') {
      log.info('landing opening workspace', { workspaceId: action.workspaceId })
      void navigate({
        to: '/w/$workspaceId',
        params: { workspaceId: action.workspaceId },
        search: { chat: undefined, tab: undefined },
        replace: true,
      })
      return
    }
    log.info('landing creating workspace')
    void create.mutateAsync({}).then((workspace) =>
      navigate({
        to: '/w/$workspaceId',
        params: { workspaceId: workspace.id },
        search: { chat: undefined, tab: undefined },
        replace: true,
      }),
    ).catch((error) => {
      started.current = false
      log.warn('landing create workspace failed', { message: error instanceof Error ? error.message : String(error) })
    })
  }, [create, list.data, list.error, list.isError, list.isLoading, navigate])

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-500">
      Opening workspace…
    </div>
  )
}
