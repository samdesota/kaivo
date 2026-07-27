import { useSyncExternalStore } from 'react'
import type { WorkspaceSidebarNode } from '../../data/modules/workspace-folders'
import type { WorkspaceRecord } from '../../data/modules/workspaces'
import type { WorkspaceTab } from './tab-state'
import type { WorkspaceResourceRecord } from './resources-store'
import type { AgentNotificationRecord } from './notifications-store'

export type GlobalTabsWorkspaceSummary = {
  id: string
  name: string
}

export type GlobalTabDestination = {
  workspace: GlobalTabsWorkspaceSummary | null
  tabs: WorkspaceTab[]
  activeTabId: string | null
}

export type WorkspaceSidebarChatRollup = {
  hasData: boolean
  chatCount: number
  runningCount: number
  pendingAttentionCount: number
  newResponseCount: number
}

export type WorkspaceSidebarSubtask = {
  id: string
  dispatchSessionId: string
  sessionId: string | null
  title: string
  state: 'provisioning' | 'active' | 'returned' | 'completed' | 'failed'
  running: boolean
  pendingAttentionCount: number
  latestReturnSummary: string | null
  createdAt: string
}

export type WorkspaceSidebarStateSnapshot = {
  currentWorkspaceId: string
  activeSessionId: string | null
  localEnvAvailable: boolean
  nodes: WorkspaceSidebarNode[]
  workspaces: WorkspaceRecord[]
  resources: WorkspaceResourceRecord[]
  globalTabsDestination: GlobalTabDestination
  chatRollups: Record<string, WorkspaceSidebarChatRollup>
  subtasks: Record<string, WorkspaceSidebarSubtask[]>
  notifications: AgentNotificationRecord[]
}

export interface WorkspaceSidebarStateSource {
  getSnapshot(): WorkspaceSidebarStateSnapshot | null
  subscribe(listener: () => void): () => void
}

export function useWorkspaceSidebarState(source: WorkspaceSidebarStateSource): WorkspaceSidebarStateSnapshot | null {
  return useSyncExternalStore(
    (listener) => source.subscribe(listener),
    () => source.getSnapshot(),
    () => source.getSnapshot(),
  )
}

export class WorkspaceSidebarBridgeStateSource implements WorkspaceSidebarStateSource {
  private snapshot: WorkspaceSidebarStateSnapshot | null = null
  private listeners = new Set<() => void>()

  getSnapshot(): WorkspaceSidebarStateSnapshot | null {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  update(snapshot: WorkspaceSidebarStateSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
