import { useEffect, useRef } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { trpc } from '../trpc'
import { chooseWorkspaceLandingAction } from './workspace-landing-state'

export function WorkspaceLandingPage() {
  const navigate = useNavigate()
  const list = trpc.workspace.list.useQuery()
  const create = trpc.workspace.create.useMutation()
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    const action = chooseWorkspaceLandingAction(list.isLoading, list.data)
    if (action.type === 'wait') return
    started.current = true
    if (action.type === 'open') {
      void navigate({
        to: '/w/$workspaceId',
        params: { workspaceId: action.workspaceId },
        search: { chat: undefined, tab: undefined },
        replace: true,
      })
      return
    }
    void create.mutateAsync({}).then((workspace) =>
      navigate({
        to: '/w/$workspaceId',
        params: { workspaceId: workspace.id },
        search: { chat: undefined, tab: undefined },
        replace: true,
      }),
    )
  }, [create, list.data, list.isLoading, navigate])

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-500">
      Opening workspace…
    </div>
  )
}
