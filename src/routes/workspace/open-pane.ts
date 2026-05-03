import type { PaneContent } from '../env/shell/tab-state'
import type { WorkspaceTab } from './tab-state'

export function workspaceTabFromPaneContent(
  content: PaneContent,
  envId: string | undefined,
  options?: { title?: string },
): WorkspaceTab | null {
  if (content.type !== 'browser' && !envId) return null
  const id = makeWorkspaceTabId(content.type, envId)
  if (content.type === 'shell') {
    return { id, type: 'shell', envId: envId!, shellId: content.shellId, title: options?.title ?? `shell ${content.shellId.slice(-8)}` }
  }
  if (content.type === 'file') {
    return { id, type: 'file', envId: envId!, path: content.path, title: options?.title ?? content.path.split('/').pop() ?? content.path }
  }
  if (content.type === 'preview') {
    return { id, type: 'preview', envId: envId!, port: content.port, title: options?.title ?? `preview :${content.port}` }
  }
  if (!content.url) return null
  return { id, type: 'browser', url: content.url, browserTabId: content.browserTabId, title: options?.title ?? content.url }
}

export function makeWorkspaceTabId(type: string, envId?: string): string {
  return `${type}-${envId ?? 'browser'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
