import { useLayoutEffect, useMemo } from 'react'
import { paneTabIconForType } from '../../../../components/tab-icon'
import { envTrpc } from '../../../../env-trpc'
import { extractTrpcMessage } from '../../../../lib/utils'
import { CompactPath, UniversalMenuResultList, selectResult } from '../shared'
import type { UniversalMenuResult, UniversalScopeModule, UniversalScopeProps } from '../types'
import { disabledRow, displayPath } from '../utils'

interface ShellRow {
  id: string
  cwd: string
  title: string | null
  ownerKind?: string
  alive?: boolean
}

interface FolderProbeData {
  home?: string | null
}

export const shellsScopeModule: UniversalScopeModule = {
  id: 'shells',
  label: 'Shells',
  key: '$',
  detail: 'Search workspace shells',
  placeholder: 'Shell search lands in Task 6',
  Component: ShellsScope,
}

export function ShellsScope(props: UniversalScopeProps) {
  const { activeIndex, actionMenuIndex, mouseMoved, onActiveChange, onClose, onMouseMoved, onOpenActions, onOpenContent, onRunAction, query, setScopeApi, workspaceId } = props
  const envUtils = envTrpc.useUtils()
  const folderProbe = envTrpc.fs.browseHome.useQuery({ path: undefined }, { refetchOnWindowFocus: false, staleTime: 30_000 })
  const shells = envTrpc.shell.list.useQuery(workspaceId ? { workspaceId } : undefined, { enabled: !!workspaceId, staleTime: 5_000 })
  const disposeShell = envTrpc.shell.dispose.useMutation()
  const homePath = (folderProbe.data as FolderProbeData | undefined)?.home ?? undefined
  const results = useMemo(() => shellScopeResults({
    shells: shells.data as ShellRow[] | undefined,
    loading: shells.isLoading,
    error: shells.error,
    query,
    homePath,
    openShell: (shellId) => onOpenContent?.({ type: 'shell', shellId }),
    deleteShell: async (shellId) => {
      await disposeShell.mutateAsync({ id: shellId })
      await envUtils.shell.list.invalidate(workspaceId ? { workspaceId } : undefined)
    },
  }), [disposeShell, envUtils.shell.list, homePath, onOpenContent, query, shells.data, shells.error, shells.isLoading, workspaceId])

  useLayoutEffect(() => {
    const activeResult = results[activeIndex]
    setScopeApi({
      resultCount: results.length,
      selectActive: (event) => selectResult(results, activeIndex, onClose, event),
      activeActions: activeResult?.actions,
    })
  }, [activeIndex, onClose, results, setScopeApi])

  return <UniversalMenuResultList results={results} activeIndex={activeIndex} actionMenuIndex={actionMenuIndex} mouseMoved={mouseMoved} onMouseMoved={onMouseMoved} onActiveChange={onActiveChange} onOpenActions={onOpenActions} onRunAction={onRunAction} onSelect={(index, event) => void selectResult(results, index, onClose, event)} loading={shells.isFetching} />
}

function shellScopeResults({ shells, loading, error, query, homePath, openShell, deleteShell }: { shells?: ShellRow[]; loading: boolean; error: unknown; query: string; homePath?: string; openShell: (shellId: string) => void; deleteShell: (shellId: string) => void | Promise<void> }): UniversalMenuResult[] {
  if (loading) return [disabledRow('shells-loading', 'Loading shells...')]
  if (error) return [disabledRow('shells-error', extractTrpcMessage(error))]
  const q = query.trim().toLowerCase()
  const rows = (shells ?? [])
    .filter((shell) => shell.alive !== false)
    .filter((shell) => !q || `${shell.title ?? ''} ${shell.id} ${shell.cwd} ${shell.ownerKind ?? ''}`.toLowerCase().includes(q))
    .map((shell): UniversalMenuResult => ({
      id: `shell:${shell.id}`,
      kind: 'shell',
      label: shell.title || `shell ${shell.id.slice(-6)}`,
      detailNode: <CompactPath path={displayPath(shell.cwd, homePath)} />,
      icon: paneTabIconForType('shell'),
      haystack: `${shell.title ?? ''} ${shell.id} ${shell.cwd}`,
      run: () => openShell(shell.id),
      actions: [{ id: 'terminate', label: 'Terminate shell', key: 't', run: () => deleteShell(shell.id) }],
    }))
  return rows.length ? rows : [disabledRow('shells-empty', q ? 'No matching shells.' : 'No shells in this workspace.')]
}
