import type { ReactNode } from 'react'
import type { TabIcon } from '../../../components/tab-icon'
import type { PaneContent } from '../shell/tab-state'
import type { NewAgentChatSelection } from '../agent/new-agent-chat-state'

export type UniversalMenuResultKind =
  | 'action'
  | 'scope'
  | 'folder'
  | 'worktree'
  | 'shell'
  | 'browser-tab'
  | 'bookmark'
  | 'workspace'
  | 'file'

export interface UniversalMenuResult {
  id: string
  kind: UniversalMenuResultKind
  label: string
  labelNode?: ReactNode
  detail?: string
  detailNode?: ReactNode
  actionHint?: string
  badge?: string
  icon?: TabIcon
  parentId?: string
  depth?: number
  flatHierarchy?: boolean
  haystack: string
  disabled?: boolean
  keepOpen?: boolean
  run: () => void | Promise<void>
  alternateRun?: () => void | Promise<void>
  actions?: UniversalMenuResultAction[]
  drill?: () => void
}

export interface UniversalMenuResultAction {
  id: string
  label: string
  key: string
  run: () => void | Promise<void>
}

export interface UniversalMenuContextItem {
  id: string
  kind: 'shell' | 'browser-tab'
  label: string
  detail?: string
  content: PaneContent
}

export interface UniversalMenuRenderState {
  active: boolean
  disabled: boolean
  onMouseEnter: () => void
  onSelect: (event?: { shiftKey?: boolean }) => void
  onAlternateSelect: () => void
  actionMenuOpen: boolean
  onOpenActions: () => void
  onRunAction: (action: UniversalMenuResultAction) => void
}

export type ScopeId = 'open-folder' | 'recent-folders' | 'work-trees' | 'find-files' | 'web' | 'shells' | 'workspaces'

export interface ScopeDefinition {
  id: ScopeId
  label: string
  key: string
  detail: string
  placeholder: string
}

export interface UniversalScopeApi {
  resultCount: number
  footerHints?: string[]
  selectActive: (event?: { shiftKey?: boolean }) => void | Promise<void>
  selectAlternateActive?: () => void | Promise<void>
  activeActions?: UniversalMenuResultAction[]
  handleKeyDown?: (event: KeyboardEvent) => boolean
}

export interface UniversalScopeProps {
  query: string
  setQuery: (query: string) => void
  activeIndex: number
  mouseMoved: boolean
  workspaceId?: string
  workspaceFolderId?: string | null
  activeSessionId?: string | null
  contextItems: UniversalMenuContextItem[]
  onActiveChange: (index: number) => void
  onMouseMoved: () => void
  actionMenuIndex?: number | null
  onOpenActions?: (index: number) => void
  onRunAction?: (action: UniversalMenuResultAction) => void
  onClose: () => void
  onOpenContent?: (content: PaneContent) => void
  onCreatedChat?: (sessionId: string, workspaceId?: string) => void
  onSwitchWorkspace?: (workspaceId: string) => void
  openDetails: (selection: NewAgentChatSelection) => void
  setScopeApi: (api: UniversalScopeApi | null) => void
}

export interface UniversalScopeModule {
  id: ScopeId
  label: string
  key: string
  detail: string
  placeholder: string
  Component: (props: UniversalScopeProps) => ReactNode
}
