import type { WorkspaceTab } from '../../../../shared/workspace-pane'

export type { WorkspaceTab }

export type WorkspaceTabRecord = {
  workspaceId: string
  id: string
  type: WorkspaceTab['type']
  title: string
  titleSource: 'auto' | 'explicit' | null
  position: number
  envId: string | null
  shellId: string | null
  path: string | null
  repoRoot: string | null
  sessionId: string | null
  port: number | null
  url: string | null
  browserTabId: string | null
  faviconUrl: string | null
  updatedAt: number
}
