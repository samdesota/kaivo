export type PaneContent =
  | { type: 'shell'; shellId: string }
  | { type: 'file'; path: string; absolute?: boolean }
  | { type: 'browser'; url?: string; browserTabId?: string; faviconUrl?: string }
  | { type: 'git-diff'; cwd: string }
  | { type: 'code-walkthrough'; cwd: string; walkthroughId?: string }

export type WorkspaceTab =
  | { id: string; type: 'shell'; envId: string; shellId: string; title: string; titleSource?: 'auto' | 'explicit' }
  | { id: string; type: 'file'; envId: string; path: string; sessionId?: string; title: string }
  | { id: string; type: 'browser'; url: string; browserTabId?: string; faviconUrl?: string; title: string }
  | { id: string; type: 'git-diff'; envId: string; repoRoot: string; title: string }
  | { id: string; type: 'code-walkthrough'; envId: string; repoRoot: string; walkthroughId?: string; title: string }

export function makeWorkspaceTabId(type: string, envId?: string): string {
  return `${type}-${envId ?? 'browser'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function workspaceTabKey(tab: WorkspaceTab): string {
  if (tab.type === 'shell') return `shell:${tab.envId}:${tab.shellId}`
  if (tab.type === 'file') return `file:${tab.envId}:${tab.sessionId ?? ''}:${tab.path}`
  if (tab.type === 'git-diff') return `git-diff:${tab.envId}:${tab.repoRoot}`
  if (tab.type === 'code-walkthrough') return `code-walkthrough:${tab.envId}:${tab.repoRoot}`
  return `browser:${tab.id}`
}

export function workspaceTabFromPaneContent(
  content: PaneContent,
  envId: string | undefined,
  options?: { title?: string },
): WorkspaceTab | null {
  if (content.type !== 'browser' && !envId) return null
  const id = makeWorkspaceTabId(content.type, envId)
  if (content.type === 'shell') {
    return { id, type: 'shell', envId: envId!, shellId: content.shellId, title: options?.title ?? `shell ${content.shellId.slice(-8)}`, titleSource: options?.title ? 'explicit' : 'auto' }
  }
  if (content.type === 'file') {
    return { id, type: 'file', envId: envId!, path: content.path, title: options?.title ?? content.path.split('/').pop() ?? content.path }
  }
  if (content.type === 'git-diff') {
    return { id, type: 'git-diff', envId: envId!, repoRoot: content.cwd, title: options?.title ?? 'Git Diff' }
  }
  if (content.type === 'code-walkthrough') {
    return { id, type: 'code-walkthrough', envId: envId!, repoRoot: content.cwd, walkthroughId: content.walkthroughId, title: options?.title ?? 'Code Walkthrough' }
  }
  if (!content.url) return null
  return { id, type: 'browser', url: content.url, browserTabId: content.browserTabId, faviconUrl: content.faviconUrl, title: options?.title ?? content.url }
}
