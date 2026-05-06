export interface OpenPaneOptions {
  title?: string
  activate?: boolean
}

export interface AgentUiOpenPaneEvent<Content> {
  type: string
  content: Content
  title?: string
  activate: boolean
}

export function handleAgentUiOpenPaneEvent<Content>(
  evt: AgentUiOpenPaneEvent<Content>,
  onOpenPane: ((content: Content, options?: OpenPaneOptions) => void) | undefined,
  onRefreshHint?: () => void,
): void {
  if (evt.type !== 'open_pane') return
  if (onRefreshHint) {
    onRefreshHint()
    return
  }
  onOpenPane?.(evt.content, {
    title: evt.title,
    activate: evt.activate,
  })
}
