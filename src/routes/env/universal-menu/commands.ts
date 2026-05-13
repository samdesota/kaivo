import type { PaneContent } from '../shell/tab-state'
import type { ScopeDefinition, UniversalMenuResult } from './types'

export const openFolderScope: ScopeDefinition = { id: 'open-folder', label: 'File System', key: '/', detail: 'Open files or choose folders for chats', placeholder: 'File system browsing lands in Task 3' }

export const universalMenuScopes: ScopeDefinition[] = [
  openFolderScope,
  { id: 'recent-folders', label: 'Recent Folders', key: ':', detail: 'Search folders used by prior chats', placeholder: 'Recent folder search lands in Task 4' },
  { id: 'work-trees', label: 'Work Trees', key: '#', detail: 'Search repo worktrees', placeholder: 'Worktree search lands in Task 5' },
  { id: 'find-files', label: 'Find Files', key: '.', detail: 'Search git files in open chat folders', placeholder: 'File search lands in Task 9' },
  { id: 'web', label: 'Web', key: '@', detail: 'Search tabs and bookmarks', placeholder: 'Web search lands in Task 7' },
  { id: 'shells', label: 'Shells', key: '$', detail: 'Search workspace shells', placeholder: 'Shell search lands in Task 6' },
  { id: 'workspaces', label: 'Workspaces', key: '>', detail: 'Switch workspace', placeholder: 'Workspace search lands in Task 8' },
]

export const scopeByKey = new Map(universalMenuScopes.map((scope) => [scope.key, scope]))

export interface UniversalMenuCommandContext {
  activeCwd?: string
  workspaceId?: string
  hasActiveTab: boolean
  scopes: ScopeDefinition[]
  enterScope: (definition: ScopeDefinition, initialQuery: string) => void
  createShell: { mutateAsync: (input: { workspaceId?: string; cwd?: string }) => Promise<{ id: string }> }
  onCloseTab: () => void
  onOpenContent?: (content: PaneContent) => void
  onOpenSettings?: () => void
  onToggleAgentPane?: () => void
  onToggleSidebar?: () => void
}

interface UniversalMenuCommandDefinition {
  id: string
  kind: UniversalMenuResult['kind']
  label: string
  haystack: string | ((context: UniversalMenuCommandContext) => string)
  badge?: string
  allowed: (context: UniversalMenuCommandContext) => boolean
  disabled?: (context: UniversalMenuCommandContext) => boolean
  run: (context: UniversalMenuCommandContext) => void | Promise<void>
}

const scopeCommandDefinitions: UniversalMenuCommandDefinition[] = universalMenuScopes.map((definition) => ({
  id: `scope:${definition.id}`,
  kind: 'scope',
  label: definition.label,
  badge: definition.key,
  haystack: `${definition.label} ${definition.detail} ${definition.key}`,
  allowed: () => true,
  run: (context) => context.enterScope(definition, ''),
}))

const actionCommandDefinitions: UniversalMenuCommandDefinition[] = [
  {
    id: 'action:new-shell',
    kind: 'action',
    label: 'New shell',
    haystack: 'new shell terminal command workspace',
    allowed: () => true,
    run: async (context) => {
      const info = await context.createShell.mutateAsync({
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(context.activeCwd ? { cwd: context.activeCwd } : {}),
      })
      context.onOpenContent?.({ type: 'shell', shellId: info.id })
    },
  },
  {
    id: 'action:close-tab',
    kind: 'action',
    label: 'Close current tab',
    haystack: 'close current tab pane browser shell file',
    allowed: (context) => context.hasActiveTab,
    run: (context) => context.onCloseTab(),
  },
  {
    id: 'action:toggle-agent-pane',
    kind: 'action',
    label: 'Collapse agent pane',
    haystack: 'collapse expand toggle agent pane chat',
    allowed: () => true,
    disabled: (context) => !context.onToggleAgentPane,
    run: (context) => context.onToggleAgentPane?.(),
  },
  {
    id: 'action:toggle-sidebar',
    kind: 'action',
    label: 'Collapse sidebar',
    haystack: 'collapse expand toggle sidebar workspace navigation',
    allowed: () => true,
    disabled: (context) => !context.onToggleSidebar,
    run: (context) => context.onToggleSidebar?.(),
  },
  {
    id: 'action:settings',
    kind: 'action',
    label: 'Settings',
    haystack: 'settings preferences configuration providers credentials',
    allowed: () => true,
    disabled: (context) => !context.onOpenSettings,
    run: (context) => context.onOpenSettings?.(),
  },
]

const commandDefinitions = [...scopeCommandDefinitions, ...actionCommandDefinitions]

export function universalMenuCommandResults(context: UniversalMenuCommandContext): UniversalMenuResult[] {
  return commandDefinitions
    .filter((definition) => definition.allowed(context))
    .map((definition): UniversalMenuResult => ({
      id: definition.id,
      kind: definition.kind,
      label: definition.label,
      badge: definition.badge,
      haystack: typeof definition.haystack === 'function' ? definition.haystack(context) : definition.haystack,
      disabled: definition.disabled?.(context),
      run: () => definition.run(context),
    }))
}
