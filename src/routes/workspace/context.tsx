import { createContext, useContext, type ReactNode } from 'react'
import type { WorkspaceEnvTarget } from './env-targets'
import type { WorkspaceUiState } from './tab-state'

export type WorkspaceRecord = {
  id: string
  name: string
  createdAt: Date
  updatedAt: Date
  lastOpenedAt: Date | null
  archivedAt: Date | null
}

export type WorkspaceContextValue = {
  workspace: WorkspaceRecord
  uiState: WorkspaceUiState
  envTargets: WorkspaceEnvTarget[]
  localEnvTarget: WorkspaceEnvTarget | null
  getEnvClient: (envId: string) => unknown
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

export function WorkspaceContextProvider({
  value,
  children,
}: {
  value: WorkspaceContextValue
  children: ReactNode
}) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error('useWorkspaceContext must be used inside WorkspaceContextProvider')
  return ctx
}
