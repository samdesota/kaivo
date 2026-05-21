import { browserApi } from '../../lib/browser-api'

type WorkspaceBrowserTabLike = {
  type: string
  browserTabId?: string | null
}

export async function closeNativeBrowserTabsForWorkspace(tabs: WorkspaceBrowserTabLike[]): Promise<void> {
  if (!browserApi.isAvailable()) return
  const browserTabIds = new Set<string>()
  for (const tab of tabs) {
    if (tab.type === 'browser' && tab.browserTabId) browserTabIds.add(tab.browserTabId)
  }
  await Promise.all([...browserTabIds].map(async (browserTabId) => {
    try {
      await browserApi.closeTab({ browserTabId })
    } catch (error) {
      console.info('Native browser tab cleanup failed', error)
    }
  }))
}
