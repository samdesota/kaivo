import { useLayoutEffect, useMemo } from 'react'
import { paneTabIconForType } from '../../../../components/tab-icon'
import { envTrpc } from '../../../../env-trpc'
import { extractTrpcMessage } from '../../../../lib/utils'
import { CompactPath, UniversalMenuResultList, selectResult } from '../shared'
import type { UniversalMenuResult, UniversalScopeModule, UniversalScopeProps } from '../types'
import { basename, disabledRow, displayPath } from '../utils'

interface RecentFolderRow {
  path: string
  label: string | null
}

interface AgentSessionRow {
  id: string
  workingDir: string | null
}

interface FolderProbeData {
  home?: string | null
}

export const recentFoldersScopeModule: UniversalScopeModule = {
  id: 'recent-folders',
  label: 'Recent Folders',
  key: ':',
  detail: 'Search folders used by prior chats',
  placeholder: 'Recent folder search lands in Task 4',
  Component: RecentFoldersScope,
}

export function RecentFoldersScope(props: UniversalScopeProps) {
  const { activeIndex, mouseMoved, onActiveChange, onClose, onCreatedChat, onMouseMoved, openDetails, query, setScopeApi, workspaceId } = props
  const folderProbe = envTrpc.fs.browseHome.useQuery({ path: undefined }, { refetchOnWindowFocus: false, staleTime: 30_000 })
  const sessions = envTrpc.agent.sessionList.useQuery(workspaceId ? { workspaceId } : undefined, { enabled: !!workspaceId, staleTime: 5_000 })
  const recentFolders = envTrpc.repo.listRecentFolders.useQuery(undefined, { staleTime: 5_000 })
  const startChat = envTrpc.agent.sessionStart.useMutation()
  const homePath = (folderProbe.data as FolderProbeData | undefined)?.home ?? undefined
  const workspaceFolders = useMemo(() => Array.from(new Set(((sessions.data as AgentSessionRow[] | undefined) ?? []).map((session) => session.workingDir).filter((dir): dir is string => Boolean(dir)))), [sessions.data])

  const results = useMemo(() => recentFolderScopeResults({
    folders: recentFolders.data as RecentFolderRow[] | undefined,
    loading: recentFolders.isLoading,
    error: recentFolders.error,
    query,
    homePath,
    workspaceFolders,
    workspaceId,
    openNewWorkspaceChat: (path) => openDetails({ type: 'folder', path }),
    startChat: async (path) => {
      if (!workspaceId) return
      const created = await startChat.mutateAsync({ workspaceId, directory: path }) as { id: string }
      onCreatedChat?.(created.id, workspaceId)
    },
  }), [homePath, onCreatedChat, openDetails, query, recentFolders.data, recentFolders.error, recentFolders.isLoading, startChat, workspaceFolders, workspaceId])

  useLayoutEffect(() => {
    setScopeApi({ resultCount: results.length, selectActive: (event) => selectResult(results, activeIndex, onClose, event) })
  }, [activeIndex, onClose, results, setScopeApi])

  return (
    <UniversalMenuResultList
      results={results}
      activeIndex={activeIndex}
      mouseMoved={mouseMoved}
      onMouseMoved={onMouseMoved}
      onActiveChange={onActiveChange}
      onSelect={(index, event) => void selectResult(results, index, onClose, event)}
      loading={recentFolders.isFetching}
    />
  )
}

function recentFolderScopeResults({ folders, loading, error, query, homePath, workspaceFolders, workspaceId, openNewWorkspaceChat, startChat }: { folders?: RecentFolderRow[]; loading: boolean; error: unknown; query: string; homePath?: string; workspaceFolders: string[]; workspaceId?: string; openNewWorkspaceChat: (path: string) => void; startChat: (path: string) => Promise<void> }): UniversalMenuResult[] {
  if (loading) return [disabledRow('recent-folders-loading', 'Loading recent folders...')]
  if (error) return [disabledRow('recent-folders-error', extractTrpcMessage(error))]
  const q = query.trim().toLowerCase()
  const workspaceSet = new Set(workspaceFolders)
  const rows = (folders ?? [])
    .filter((folder) => !q || `${folder.label ?? ''} ${folder.path}`.toLowerCase().includes(q))
    .map((folder): UniversalMenuResult => ({
      id: `recent-folder:${folder.path}`,
      kind: 'folder',
      label: folder.label ?? basename(folder.path),
      detailNode: <CompactPath path={displayPath(folder.path, homePath)} />,
      badge: workspaceSet.has(folder.path) ? 'current workspace' : undefined,
      icon: paneTabIconForType('file'),
      haystack: `${folder.label ?? ''} ${folder.path}`,
      disabled: !workspaceId,
      run: () => startChat(folder.path),
      alternateRun: () => openNewWorkspaceChat(folder.path),
    }))
  return rows.length ? rows : [disabledRow('recent-folders-empty', q ? 'No matching recent folders.' : 'No recent folders yet.')]
}
