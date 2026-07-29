import { BookOpenText, FileText, GitCompareArrows, Globe, Terminal } from 'lucide-react'
import { useState } from 'react'

export type PaneIconKind = 'shell' | 'file' | 'browser' | 'git-diff' | 'code-walkthrough'

export type TabIcon =
  | { kind: 'pane'; pane: PaneIconKind }
  | { kind: 'favicon'; url: string; fallback: { kind: 'pane'; pane: 'browser' } }

export function paneTabIconForType(type: PaneIconKind): TabIcon {
  return { kind: 'pane', pane: type }
}

export function TabIconView({ icon }: { icon: TabIcon }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (icon.kind === 'favicon') {
    if (failedUrl === icon.url) return <TabIconView icon={icon.fallback} />
    return (
      <img
        src={icon.url}
        alt=""
        aria-hidden="true"
        className="shrink-0 rounded-[2px] object-contain"
        style={{ width: 12, height: 12 }}
        draggable={false}
        onError={() => setFailedUrl(icon.url)}
      />
    )
  }

  const Icon = icon.pane === 'shell' ? Terminal : icon.pane === 'file' ? FileText : icon.pane === 'git-diff' ? GitCompareArrows : icon.pane === 'code-walkthrough' ? BookOpenText : Globe
  return <Icon aria-hidden="true" size={12} strokeWidth={1.8} className="shrink-0" />
}
