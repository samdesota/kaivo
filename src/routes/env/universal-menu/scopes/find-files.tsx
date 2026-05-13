import { useLayoutEffect, useMemo, useRef } from 'react'
import { FilePathLabel } from '../../../../components/file-path-label'
import { paneTabIconForType } from '../../../../components/tab-icon'
import { envTrpc } from '../../../../env-trpc'
import { extractTrpcMessage } from '../../../../lib/utils'
import { UniversalMenuResultList, selectResult } from '../shared'
import type { UniversalMenuResult, UniversalScopeModule, UniversalScopeProps } from '../types'
import { basename, disabledRow, displayPath, groupRow } from '../utils'

interface AgentSessionRow {
  id: string
  workingDir: string | null
}

interface GitFileRow {
  root: string
  path: string
  relativePath: string
}

export const findFilesScopeModule: UniversalScopeModule = {
  id: 'find-files',
  label: 'Find Files',
  key: '.',
  detail: 'Search git files in open chat folders',
  placeholder: 'File search lands in Task 9',
  Component: FindFilesScope,
}

export function FindFilesScope(props: UniversalScopeProps) {
  const { activeIndex, mouseMoved, onActiveChange, onClose, onMouseMoved, onOpenContent, query, setScopeApi, workspaceId } = props
  const sessions = envTrpc.agent.sessionList.useQuery(workspaceId ? { workspaceId } : undefined, {
    enabled: !!workspaceId,
    staleTime: 5_000,
  })
  const fileRoots = useMemo(() => Array.from(new Set(((sessions.data as AgentSessionRow[] | undefined) ?? []).map((session) => session.workingDir).filter((dir): dir is string => Boolean(dir)))), [sessions.data])
  const gitFiles = envTrpc.fs.searchGitTrackedFiles.useQuery(
    { roots: fileRoots, query, limit: 160 },
    { enabled: fileRoots.length > 0, staleTime: 10_000 },
  )
  const previousResultsRef = useRef<UniversalMenuResult[]>([])
  const homePath = undefined
  const results = useMemo(() => {
    const next = findFilesScopeResults({
      roots: fileRoots,
      files: gitFiles.data as GitFileRow[] | undefined,
      loading: gitFiles.isLoading,
      error: gitFiles.error,
      query,
      homePath,
      openFile: (path) => onOpenContent?.({ type: 'file', path, absolute: true }),
    })
    if (gitFiles.isLoading && previousResultsRef.current.length > 0) return previousResultsRef.current
    if (!gitFiles.isLoading && next.length > 0) previousResultsRef.current = next
    return next
  }, [fileRoots, gitFiles.data, gitFiles.error, gitFiles.isLoading, homePath, onOpenContent, query])

  useLayoutEffect(() => {
    setScopeApi({
      resultCount: results.length,
      selectActive: (event) => selectResult(results, activeIndex, onClose, event),
    })
  }, [activeIndex, onClose, results, setScopeApi])

  return (
    <UniversalMenuResultList
      results={results}
      activeIndex={activeIndex}
      mouseMoved={mouseMoved}
      onMouseMoved={onMouseMoved}
      onActiveChange={onActiveChange}
      onSelect={(index, event) => void selectResult(results, index, onClose, event)}
      loading={gitFiles.isFetching}
    />
  )
}

function findFilesScopeResults({ roots, files, loading, error, query, homePath, openFile }: { roots: string[]; files?: GitFileRow[]; loading: boolean; error: unknown; query: string; homePath?: string; openFile: (path: string) => void }): UniversalMenuResult[] {
  if (roots.length === 0) return [disabledRow('find-files-no-roots', 'Open a chat in a folder to search git-tracked files.')]
  if (loading) return [disabledRow('find-files-loading', 'Loading files...')]
  if (error) return [disabledRow('find-files-error', extractTrpcMessage(error))]
  const rows: UniversalMenuResult[] = []
  const filesByRoot = new Map<string, GitFileRow[]>()
  for (const file of files ?? []) {
    const rootFiles = filesByRoot.get(file.root)
    if (rootFiles) rootFiles.push(file)
    else filesByRoot.set(file.root, [file])
  }
  for (const [root, rootFiles] of filesByRoot) {
    const groupId = `file-root:${root}`
    rows.push(groupRow(groupId, basename(root), 0, displayPath(root, homePath)))
    for (const file of rootFiles) {
      rows.push({
        id: `file:${file.root}:${file.relativePath}`,
        kind: 'file',
        label: file.relativePath,
        labelNode: <FilePathLabel path={file.relativePath} />,
        parentId: groupId,
        depth: 1,
        flatHierarchy: true,
        icon: paneTabIconForType('file'),
        haystack: `${file.relativePath} ${file.path}`,
        run: () => openFile(file.path),
      })
    }
  }
  return rows.length ? rows : [disabledRow('find-files-empty', query.trim() ? 'No matching tracked files.' : 'No tracked files found in open chat folders.')]
}
