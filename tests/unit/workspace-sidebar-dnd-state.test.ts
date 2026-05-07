import { describe, expect, it } from 'vitest'
import {
  flattenSidebarTree,
  moveSidebarNodeInTree,
  projectSidebarDrop,
  sidebarDndId,
  type SidebarTreeNode,
} from '../../src/routes/workspace/sidebar-dnd-state'

const tree: SidebarTreeNode[] = [
  {
    type: 'folder',
    folder: { id: 'cloud', parentId: null, position: 0 },
    children: [
      { type: 'workspace', workspace: { id: 'tools', folderId: 'cloud', position: 0 } },
      {
        type: 'folder',
        folder: { id: 'packages', parentId: 'cloud', position: 1 },
        children: [{ type: 'workspace', workspace: { id: 'plugin', folderId: 'packages', position: 0 } }],
      },
    ],
  },
  { type: 'workspace', workspace: { id: 'scratch', folderId: null, position: 1 } },
]

describe('workspace sidebar drag state', () => {
  it('flattens visible tree rows with parent and depth metadata', () => {
    expect(flattenSidebarTree(tree)).toEqual([
      { id: 'cloud', kind: 'folder', parentFolderId: null, depth: 0, position: 0, ancestorFolderIds: [] },
      { id: 'tools', kind: 'workspace', parentFolderId: 'cloud', depth: 1, position: 0, ancestorFolderIds: ['cloud'] },
      { id: 'packages', kind: 'folder', parentFolderId: 'cloud', depth: 1, position: 1, ancestorFolderIds: ['cloud'] },
      { id: 'plugin', kind: 'workspace', parentFolderId: 'packages', depth: 2, position: 0, ancestorFolderIds: ['cloud', 'packages'] },
      { id: 'scratch', kind: 'workspace', parentFolderId: null, depth: 0, position: 1, ancestorFolderIds: [] },
    ])
  })

  it('projects workspace before, after, and inside folder targets', () => {
    expect(projectSidebarDrop({
      nodes: tree,
      activeDndId: sidebarDndId('workspace', 'scratch'),
      overDndId: sidebarDndId('workspace', 'tools'),
      placement: 'before',
    })).toMatchObject({ parentFolderId: 'cloud', beforeNodeId: 'workspace:tools' })

    expect(projectSidebarDrop({
      nodes: tree,
      activeDndId: sidebarDndId('workspace', 'scratch'),
      overDndId: sidebarDndId('workspace', 'tools'),
      placement: 'after',
    })).toMatchObject({ parentFolderId: 'cloud', beforeNodeId: 'folder:packages' })

    expect(projectSidebarDrop({
      nodes: tree,
      activeDndId: sidebarDndId('workspace', 'scratch'),
      overDndId: sidebarDndId('folder', 'packages'),
      placement: 'inside',
    })).toMatchObject({ parentFolderId: 'packages', beforeNodeId: null })
  })

  it('does not use the active node as the before target when reordering', () => {
    expect(projectSidebarDrop({
      nodes: tree,
      activeDndId: sidebarDndId('folder', 'packages'),
      overDndId: sidebarDndId('workspace', 'tools'),
      placement: 'after',
    })).toMatchObject({ parentFolderId: 'cloud', beforeNodeId: null })
  })

  it('rejects invalid drops into workspaces or folder descendants', () => {
    expect(projectSidebarDrop({
      nodes: tree,
      activeDndId: sidebarDndId('workspace', 'scratch'),
      overDndId: sidebarDndId('workspace', 'tools'),
      placement: 'inside',
    })).toBeNull()

    expect(projectSidebarDrop({
      nodes: tree,
      activeDndId: sidebarDndId('folder', 'cloud'),
      overDndId: sidebarDndId('folder', 'packages'),
      placement: 'inside',
    })).toBeNull()
  })

  it('optimistically moves nodes in the visible tree', () => {
    const moved = moveSidebarNodeInTree(tree, {
      activeKind: 'workspace',
      activeId: 'scratch',
      overId: 'packages',
      placement: 'inside',
      parentFolderId: 'packages',
      beforeNodeId: null,
    })

    expect(flattenSidebarTree(moved).map((row) => `${row.kind}:${row.id}`)).toEqual([
      'folder:cloud',
      'workspace:tools',
      'folder:packages',
      'workspace:plugin',
      'workspace:scratch',
    ])
    const packages = moved[0]?.type === 'folder' ? moved[0].children[1] : null
    expect(packages?.type).toBe('folder')
    if (packages?.type === 'folder') {
      expect(packages.children[1]).toMatchObject({ type: 'workspace', workspace: { id: 'scratch', folderId: 'packages' } })
    }
  })
})
