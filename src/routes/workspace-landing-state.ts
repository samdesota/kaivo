export type LandingWorkspace = { id: string }

export type WorkspaceLandingAction =
  | { type: 'open'; workspaceId: string }
  | { type: 'create' }
  | { type: 'wait' }

export function chooseWorkspaceLandingAction(
  loading: boolean,
  workspaces: LandingWorkspace[] | undefined,
): WorkspaceLandingAction {
  if (loading || !workspaces) return { type: 'wait' }
  const first = workspaces[0]
  if (first) return { type: 'open', workspaceId: first.id }
  return { type: 'create' }
}
