import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceSidebarTree, type WorkspaceFolderRecord } from '../../src/data/modules/workspace-folders'
import { applyWorkspaceFolderRowsForTests, renameWorkspaceFolder } from '../../src/data/modules/workspace-folders/commands'
import { workspaceFoldersCollection } from '../../src/data/modules/workspace-folders/collection'
import { applyWorkspaceRowsForTests, renameWorkspace } from '../../src/data/modules/workspaces/commands'
import { workspacesCollection } from '../../src/data/modules/workspaces/collection'
import type { WorkspaceRecord } from '../../src/data/modules/workspaces'
import { clearMemoryLocalStoreForTests } from '../../src/data/sync/local-store'

vi.mock('../../src/lib/trpc-plain', () => ({
  appTrpcMutation: vi.fn(),
}))

const { appTrpcMutation } = await import('../../src/lib/trpc-plain')

afterEach(() => {
  applyWorkspaceRowsForTests([])
  applyWorkspaceFolderRowsForTests([])
  clearMemoryLocalStoreForTests()
  vi.mocked(appTrpcMutation).mockReset()
})

describe('buildWorkspaceSidebarTree', () => {
  it('handles root folders, nested folders, archived rows, hidden/system workspaces, and deterministic ordering', () => {
    const workspaces = [
      workspace({ id: 'visible-root-late', name: 'Visible root late', position: 9, createdAt: 1 }),
      workspace({ id: 'system', name: 'System', kind: 'system', position: 0 }),
      workspace({ id: 'hidden', name: 'Hidden', hidden: true, position: 0 }),
      workspace({ id: 'archived-workspace', name: 'Archived workspace', archivedAt: 99, position: 0 }),
      workspace({ id: 'nested-workspace', name: 'Nested workspace', folderId: 'child', position: 0, createdAt: 1 }),
      workspace({ id: 'root-workspace', name: 'Root workspace', folderId: 'root', position: 0, createdAt: 2 }),
      workspace({ id: 'visible-root-first', name: 'Visible root first', position: 0, createdAt: 1 }),
    ]
    const folders = [
      folder({ id: 'archived-folder', name: 'Archived folder', archivedAt: 99, position: 0 }),
      folder({ id: 'child', name: 'Child', parentId: 'root', position: 1, createdAt: 1 }),
      folder({ id: 'root', name: 'Root', position: 1, createdAt: 1 }),
      folder({ id: 'orphan-child', name: 'Orphan child', parentId: 'missing', position: 2, createdAt: 1 }),
    ]

    const tree = buildWorkspaceSidebarTree({ workspaces, folders })

    expect(labels(tree)).toEqual([
      'workspace:visible-root-first',
      'folder:root',
      'workspace:root-workspace',
      'folder:child',
      'workspace:nested-workspace',
      'folder:orphan-child',
      'workspace:visible-root-late',
    ])
  })
})

describe('workspace and folder commands', () => {
  it('optimistically updates workspace rows and keeps the local value after backend success', async () => {
    applyWorkspaceRowsForTests([workspace({ id: 'workspace-1', name: 'Before' })])
    vi.mocked(appTrpcMutation).mockResolvedValueOnce(workspace({ id: 'workspace-1', name: 'Server' }))

    const promise = renameWorkspace({ id: 'workspace-1', name: 'After' })
    expect(workspacesCollection.getRows()[0]?.name).toBe('After')
    await promise

    expect(workspacesCollection.getRows()[0]?.name).toBe('Server')
    expect(appTrpcMutation).toHaveBeenCalledWith('workspace.rename', { id: 'workspace-1', name: 'After' })
  })

  it('reverts workspace rows on backend failure', async () => {
    applyWorkspaceRowsForTests([workspace({ id: 'workspace-1', name: 'Before' })])
    vi.mocked(appTrpcMutation).mockRejectedValueOnce(new Error('nope'))

    await expect(renameWorkspace({ id: 'workspace-1', name: 'After' })).rejects.toThrow('nope')

    expect(workspacesCollection.getRows()[0]?.name).toBe('Before')
  })

  it('optimistically updates folder rows and reverts on backend failure', async () => {
    applyWorkspaceFolderRowsForTests([folder({ id: 'folder-1', name: 'Before' })])
    vi.mocked(appTrpcMutation).mockRejectedValueOnce(new Error('folder failed'))

    const promise = renameWorkspaceFolder({ id: 'folder-1', name: 'After' })
    expect(workspaceFoldersCollection.getRows()[0]?.name).toBe('After')
    await expect(promise).rejects.toThrow('folder failed')

    expect(workspaceFoldersCollection.getRows()[0]?.name).toBe('Before')
  })
})

function labels(nodes: ReturnType<typeof buildWorkspaceSidebarTree>): string[] {
  const out: string[] = []
  function visit(nodeList: ReturnType<typeof buildWorkspaceSidebarTree>) {
    for (const node of nodeList) {
      if (node.type === 'folder') {
        out.push(`folder:${node.folder.id}`)
        visit(node.children)
      } else {
        out.push(`workspace:${node.workspace.id}`)
      }
    }
  }
  visit(nodes)
  return out
}

function workspace(input: Partial<WorkspaceRecord> & Pick<WorkspaceRecord, 'id' | 'name'>): WorkspaceRecord {
  return {
    folderId: null,
    position: 0,
    nameSource: 'explicit',
    sourceKind: null,
    sourcePath: null,
    kind: 'user',
    systemKey: null,
    hidden: false,
    protected: false,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: null,
    archivedAt: null,
    ...input,
  }
}

function folder(input: Partial<WorkspaceFolderRecord> & Pick<WorkspaceFolderRecord, 'id' | 'name'>): WorkspaceFolderRecord {
  return {
    parentId: null,
    position: 0,
    collapsed: false,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...input,
  }
}
