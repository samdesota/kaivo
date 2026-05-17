import { useLayoutEffect, useMemo } from 'react'
import { trpc } from '../../../../trpc'
import { extractTrpcMessage } from '../../../../lib/utils'
import { UniversalMenuResultList, selectResult } from '../shared'
import type { UniversalMenuResult, UniversalScopeModule, UniversalScopeProps } from '../types'
import { disabledRow, groupRow } from '../utils'

type WorkspaceTreeNode =
  | { type: 'folder'; folder: { id: string; name: string }; children: WorkspaceTreeNode[] }
  | { type: 'workspace'; workspace: { id: string; name: string; folderId?: string | null } }

export const workspacesScopeModule: UniversalScopeModule = {
  id: 'workspaces',
  label: 'Workspaces',
  key: '>',
  detail: 'Switch workspace',
  placeholder: 'Workspace search lands in Task 8',
  Component: WorkspacesScope,
}

export function WorkspacesScope(props: UniversalScopeProps) {
  const { activeIndex, mouseMoved, onActiveChange, onClose, onMouseMoved, onSwitchWorkspace, query, setScopeApi } = props
  const workspaceTree = trpc.workspace.listTree.useQuery(undefined, { staleTime: 15_000 })
  const results = useMemo(() => workspaceScopeResults({ tree: workspaceTree.data as WorkspaceTreeNode[] | undefined, loading: workspaceTree.isLoading, error: workspaceTree.error, query, switchWorkspace: (workspaceId) => onSwitchWorkspace?.(workspaceId) }), [onSwitchWorkspace, query, workspaceTree.data, workspaceTree.error, workspaceTree.isLoading])

  useLayoutEffect(() => {
    setScopeApi({ resultCount: results.length, selectActive: (event) => selectResult(results, activeIndex, onClose, event) })
  }, [activeIndex, onClose, results, setScopeApi])

  return <UniversalMenuResultList results={results} activeIndex={activeIndex} mouseMoved={mouseMoved} onMouseMoved={onMouseMoved} onActiveChange={onActiveChange} onSelect={(index, event) => void selectResult(results, index, onClose, event)} loading={workspaceTree.isFetching} />
}

function workspaceScopeResults({ tree, loading, error, query, switchWorkspace }: { tree?: WorkspaceTreeNode[]; loading: boolean; error: unknown; query: string; switchWorkspace: (workspaceId: string) => void }): UniversalMenuResult[] {
  if (loading) return [disabledRow('workspaces-loading', 'Loading workspaces...')]
  if (error) return [disabledRow('workspaces-error', extractTrpcMessage(error))]
  const rows = flattenWorkspaceRows(tree ?? [], query, switchWorkspace)
  return rows.length ? rows : [disabledRow('workspaces-empty', query.trim() ? 'No matching workspaces.' : 'No workspaces.')]
}

function flattenWorkspaceRows(tree: WorkspaceTreeNode[], query: string, switchWorkspace: (workspaceId: string) => void): UniversalMenuResult[] {
  const q = query.trim().toLowerCase()
  const rows: UniversalMenuResult[] = []
  for (const node of tree) appendWorkspaceNode(node, 0, null, q, rows, switchWorkspace)
  return rows
}

function appendWorkspaceNode(node: WorkspaceTreeNode, depth: number, parentId: string | null, query: string, rows: UniversalMenuResult[], switchWorkspace: (workspaceId: string) => void): boolean {
  if (node.type === 'workspace') {
    if (query && !node.workspace.name.toLowerCase().includes(query)) return false
    rows.push({ id: `workspace:${node.workspace.id}`, kind: 'workspace', label: node.workspace.name, depth, parentId: parentId ?? undefined, haystack: node.workspace.name, run: () => switchWorkspace(node.workspace.id) })
    return true
  }
  const start = rows.length
  const groupId = `workspace-folder:${node.folder.id}`
  rows.push(groupRow(groupId, node.folder.name, depth))
  let hasVisibleChild = false
  for (const child of node.children) hasVisibleChild = appendWorkspaceNode(child, depth + 1, groupId, query, rows, switchWorkspace) || hasVisibleChild
  const selfMatches = !query || node.folder.name.toLowerCase().includes(query)
  if (!selfMatches && !hasVisibleChild) {
    rows.splice(start, rows.length - start)
    return false
  }
  return true
}
