export type PaneContent =
  | { type: 'shell'; shellId: string }
  | { type: 'file'; path: string; absolute?: boolean }
  | { type: 'preview'; port: number }
  | { type: 'browser'; url?: string; browserTabId?: string }

export type WorkspaceTab =
  | { id: string; type: 'shell'; envId: string; shellId: string; title: string }
  | { id: string; type: 'file'; envId: string; path: string; sessionId?: string; title: string }
  | { id: string; type: 'preview'; envId: string; port: number; title: string }
  | { id: string; type: 'browser'; url: string; browserTabId?: string; title: string }

export function makeWorkspaceTabId(type: string, envId?: string): string {
  return `${type}-${envId ?? 'browser'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function workspaceTabKey(tab: WorkspaceTab): string {
  if (tab.type === 'shell') return `shell:${tab.envId}:${tab.shellId}`
  if (tab.type === 'file') return `file:${tab.envId}:${tab.sessionId ?? ''}:${tab.path}`
  if (tab.type === 'preview') return `preview:${tab.envId}:${tab.port}`
  return `browser:${tab.url}`
}

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
