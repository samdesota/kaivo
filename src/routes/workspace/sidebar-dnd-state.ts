export type SidebarNodeKind = 'folder' | 'workspace'
export type DropPlacement = 'before' | 'after' | 'inside'

export type SidebarTreeNode =
  | { type: 'folder'; folder: { id: string; parentId?: string | null; position: number; collapsed?: boolean }; children: SidebarTreeNode[] }
  | { type: 'workspace'; workspace: { id: string; folderId?: string | null; position: number } }

export type FlatSidebarNode = {
  id: string
  kind: SidebarNodeKind
  parentFolderId: string | null
  depth: number
  position: number
  ancestorFolderIds: string[]
}

export type SidebarDropProjection = {
  activeId: string
  activeKind: SidebarNodeKind
  overId: string | null
  placement: DropPlacement
  parentFolderId: string | null
  beforeNodeId: string | null
}

export function sidebarDndId(kind: SidebarNodeKind, id: string): string {
  return `${kind}:${id}`
}

export function parseSidebarDndId(id: string): { kind: SidebarNodeKind; id: string } | null {
  const [kind, ...rest] = id.split(':')
  if ((kind !== 'folder' && kind !== 'workspace') || rest.length === 0) return null
  return { kind, id: rest.join(':') }
}

export function flattenSidebarTree(nodes: SidebarTreeNode[], depth = 0, ancestorFolderIds: string[] = []): FlatSidebarNode[] {
  const out: FlatSidebarNode[] = []
  for (const node of nodes) {
    if (node.type === 'folder') {
      out.push({
        id: node.folder.id,
        kind: 'folder',
        parentFolderId: node.folder.parentId ?? null,
        depth,
        position: node.folder.position,
        ancestorFolderIds,
      })
      if (!node.folder.collapsed) out.push(...flattenSidebarTree(node.children, depth + 1, [...ancestorFolderIds, node.folder.id]))
    } else {
      out.push({
        id: node.workspace.id,
        kind: 'workspace',
        parentFolderId: node.workspace.folderId ?? null,
        depth,
        position: node.workspace.position,
        ancestorFolderIds,
      })
    }
  }
  return out
}

export function descendantFolderIds(nodes: SidebarTreeNode[], folderId: string): Set<string> {
  const found = findFolder(nodes, folderId)
  const ids = new Set<string>()
  if (!found) return ids
  collectFolderIds(found.children, ids)
  return ids
}

export function projectSidebarDrop(input: {
  nodes: SidebarTreeNode[]
  activeDndId: string
  overDndId: string | null
  placement: DropPlacement
}): SidebarDropProjection | null {
  const active = parseSidebarDndId(input.activeDndId)
  if (!active) return null
  if (!input.overDndId) {
    return { activeId: active.id, activeKind: active.kind, overId: null, placement: 'after', parentFolderId: null, beforeNodeId: null }
  }
  const over = parseSidebarDndId(input.overDndId)
  if (!over || over.id === active.id) return null
  const flat = flattenSidebarTree(input.nodes)
  const overFlat = flat.find((node) => node.id === over.id && node.kind === over.kind)
  if (!overFlat) return null
  if (input.placement === 'inside') {
    if (over.kind !== 'folder') return null
    if (active.kind === 'folder') {
      if (over.id === active.id) return null
      if (descendantFolderIds(input.nodes, active.id).has(over.id)) return null
    }
    return { activeId: active.id, activeKind: active.kind, overId: over.id, placement: 'inside', parentFolderId: over.id, beforeNodeId: null }
  }
  const siblings = flat.filter((node) => node.parentFolderId === overFlat.parentFolderId && !(node.id === active.id && node.kind === active.kind))
  const overSiblingIndex = siblings.findIndex((node) => node.id === over.id && node.kind === over.kind)
  if (overSiblingIndex < 0) return null
  const beforeNode = input.placement === 'before'
    ? siblings[overSiblingIndex]
    : siblings[overSiblingIndex + 1] ?? null
  const parentFolderId = overFlat.parentFolderId
  if (active.kind === 'folder' && parentFolderId && descendantFolderIds(input.nodes, active.id).has(parentFolderId)) return null
  return {
    activeId: active.id,
    activeKind: active.kind,
    overId: over.id,
    placement: input.placement,
    parentFolderId,
    beforeNodeId: beforeNode ? sidebarDndId(beforeNode.kind, beforeNode.id) : null,
  }
}

export function projectSidebarDropFromRows(input: {
  rows: FlatSidebarNode[]
  nodes: SidebarTreeNode[]
  activeDndId: string
  overDndId: string | null
  placement: DropPlacement
}): SidebarDropProjection | null {
  const active = parseSidebarDndId(input.activeDndId)
  if (!active) return null
  if (!input.overDndId) {
    return { activeId: active.id, activeKind: active.kind, overId: null, placement: 'after', parentFolderId: null, beforeNodeId: null }
  }
  const over = parseSidebarDndId(input.overDndId)
  if (!over || over.id === active.id) return null
  const overFlat = input.rows.find((node) => node.id === over.id && node.kind === over.kind)
  if (!overFlat) return null
  if (input.placement === 'inside') {
    if (over.kind !== 'folder') return null
    if (active.kind === 'folder' && descendantFolderIds(input.nodes, active.id).has(over.id)) return null
    return { activeId: active.id, activeKind: active.kind, overId: over.id, placement: 'inside', parentFolderId: over.id, beforeNodeId: null }
  }
  const siblings = input.rows.filter((node) => node.parentFolderId === overFlat.parentFolderId && !(node.id === active.id && node.kind === active.kind))
  const overSiblingIndex = siblings.findIndex((node) => node.id === over.id && node.kind === over.kind)
  if (overSiblingIndex < 0) return null
  const beforeNode = input.placement === 'before'
    ? siblings[overSiblingIndex]
    : siblings[overSiblingIndex + 1] ?? null
  const parentFolderId = overFlat.parentFolderId
  if (active.kind === 'folder' && parentFolderId && descendantFolderIds(input.nodes, active.id).has(parentFolderId)) return null
  return {
    activeId: active.id,
    activeKind: active.kind,
    overId: over.id,
    placement: input.placement,
    parentFolderId,
    beforeNodeId: beforeNode ? sidebarDndId(beforeNode.kind, beforeNode.id) : null,
  }
}

export function moveSidebarNodeInTree(nodes: SidebarTreeNode[], projection: SidebarDropProjection): SidebarTreeNode[] {
  const cloned = cloneTree(nodes)
  const removed = removeNode(cloned, projection.activeKind, projection.activeId)
  if (!removed) return nodes
  if (removed.type === 'folder') removed.folder.parentId = projection.parentFolderId
  else removed.workspace.folderId = projection.parentFolderId

  const targetSiblings = projection.parentFolderId ? findFolder(cloned, projection.parentFolderId)?.children : cloned
  if (!targetSiblings) return nodes
  const before = projection.beforeNodeId ? parseSidebarDndId(projection.beforeNodeId) : null
  const beforeIndex = before
    ? targetSiblings.findIndex((node) => node.type === before.kind && nodeId(node) === before.id)
    : -1
  targetSiblings.splice(before && beforeIndex >= 0 ? beforeIndex : targetSiblings.length, 0, removed)
  normalizePositions(cloned)
  return cloned
}

export function setSidebarFolderCollapsedInTree(nodes: SidebarTreeNode[], folderId: string, collapsed: boolean): SidebarTreeNode[] {
  const cloned = cloneTree(nodes)
  const folder = findFolder(cloned, folderId)
  if (!folder) return nodes
  folder.folder.collapsed = collapsed
  return cloned
}

function findFolder(nodes: SidebarTreeNode[], folderId: string): Extract<SidebarTreeNode, { type: 'folder' }> | null {
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    if (node.folder.id === folderId) return node
    const child = findFolder(node.children, folderId)
    if (child) return child
  }
  return null
}

function collectFolderIds(nodes: SidebarTreeNode[], out: Set<string>) {
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    out.add(node.folder.id)
    collectFolderIds(node.children, out)
  }
}

function cloneTree(nodes: SidebarTreeNode[]): SidebarTreeNode[] {
  return nodes.map((node) => {
    if (node.type === 'folder') {
      return { type: 'folder', folder: { ...node.folder }, children: cloneTree(node.children) }
    }
    return { type: 'workspace', workspace: { ...node.workspace } }
  })
}

function removeNode(nodes: SidebarTreeNode[], kind: SidebarNodeKind, id: string): SidebarTreeNode | null {
  const index = nodes.findIndex((node) => node.type === kind && nodeId(node) === id)
  if (index >= 0) return nodes.splice(index, 1)[0] ?? null
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    const removed = removeNode(node.children, kind, id)
    if (removed) return removed
  }
  return null
}

function nodeId(node: SidebarTreeNode): string {
  return node.type === 'folder' ? node.folder.id : node.workspace.id
}

function normalizePositions(nodes: SidebarTreeNode[]) {
  nodes.forEach((node, index) => {
    if (node.type === 'folder') {
      node.folder.position = index
      normalizePositions(node.children)
    } else {
      node.workspace.position = index
    }
  })
}
