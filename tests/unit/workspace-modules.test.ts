import { afterEach, describe, expect, it, vi } from 'vitest'
import { workspaceSearchSyncAction } from '../../src/data/modules/workspace-view-state'
import { applyWorkspaceViewStateRowsForTests, setWorkspaceSplitRatio } from '../../src/data/modules/workspace-view-state/commands'
import { workspaceViewStateCollection } from '../../src/data/modules/workspace-view-state/collection'
import { applyWorkspaceTabRowsForTests, closeWorkspaceTab, openWorkspaceTab, openWorkspaceTabLocal, reorderWorkspaceTabs } from '../../src/data/modules/workspace-tabs/commands'
import { getWorkspaceTabs } from '../../src/data/modules/workspace-tabs/selectors'
import { recordToWorkspaceTab, workspaceTabsCollection, workspaceTabToRecord } from '../../src/data/modules/workspace-tabs/collection'
import type { WorkspaceTabRecord } from '../../src/data/modules/workspace-tabs'
import { buildWorkspaceSidebarTree, type WorkspaceFolderRecord } from '../../src/data/modules/workspace-folders'
import { applyWorkspaceFolderRowsForTests, moveWorkspaceSidebarNode, renameWorkspaceFolder } from '../../src/data/modules/workspace-folders/commands'
import { workspaceFoldersCollection } from '../../src/data/modules/workspace-folders/collection'
import { applyWorkspaceRowsForTests, archiveWorkspace, renameWorkspace } from '../../src/data/modules/workspaces/commands'
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
  applyWorkspaceTabRowsForTests([])
  applyWorkspaceViewStateRowsForTests([])
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

  it('optimistically removes empty folder ancestors after archiving the last workspace', async () => {
    applyWorkspaceFolderRowsForTests([
      folder({ id: 'root', name: 'Root' }),
      folder({ id: 'child', name: 'Child', parentId: 'root' }),
    ])
    applyWorkspaceRowsForTests([workspace({ id: 'workspace-1', name: 'Only', folderId: 'child' })])
    vi.mocked(appTrpcMutation).mockResolvedValueOnce({ ok: true })

    const promise = archiveWorkspace('workspace-1')

    expect(workspaceFoldersCollection.getRows().map((row) => row.id)).toEqual([])
    await promise
  })

  it('optimistically removes empty source folders after moving their last workspace', async () => {
    applyWorkspaceFolderRowsForTests([
      folder({ id: 'source', name: 'Source' }),
      folder({ id: 'target', name: 'Target' }),
    ])
    applyWorkspaceRowsForTests([workspace({ id: 'workspace-1', name: 'Moved', folderId: 'source' })])
    vi.mocked(appTrpcMutation).mockResolvedValueOnce([
      { type: 'folder', folder: folder({ id: 'target', name: 'Target' }), children: [{ type: 'workspace', workspace: workspace({ id: 'workspace-1', name: 'Moved', folderId: 'target' }) }] },
    ])

    const promise = moveWorkspaceSidebarNode({ nodeType: 'workspace', nodeId: 'workspace-1', parentFolderId: 'target' })

    expect(workspaceFoldersCollection.getRows().map((row) => row.id)).toEqual(['target'])
    await promise
  })
})

describe('workspace tab commands', () => {
  it('round trips and restores a git diff tab record', () => {
    const tab = { id: 'diff-1', type: 'git-diff' as const, envId: 'env-1', repoRoot: '/repo', title: 'Git Diff' }
    const record = workspaceTabToRecord('workspace-1', tab, 2)

    expect(record).toMatchObject({ type: 'git-diff', envId: 'env-1', repoRoot: '/repo', position: 2 })
    expect(recordToWorkspaceTab(record)).toEqual(tab)
    expect(recordToWorkspaceTab({ ...record, repoRoot: null })).toBeNull()
  })

  it('calculates positions and avoids duplicate tabs by workspaceTabKey', async () => {
    applyWorkspaceTabRowsForTests([tabRecord({ id: 'shell-1', shellId: 'shell-1', position: 0 })])
    vi.mocked(appTrpcMutation).mockImplementation(async (procedure, input) => {
      if (procedure === 'workspace.upsertTab') {
        const value = input as { workspaceId: string; tab: Parameters<typeof workspaceTabToRecord>[1]; position: number }
        return workspaceTabToRecord(value.workspaceId, value.tab, value.position)
      }
      return { ok: true }
    })

    await openWorkspaceTab({ workspaceId: 'workspace-1', tab: { id: 'shell-duplicate', type: 'shell', envId: 'env-1', shellId: 'shell-1', title: 'Duplicate' } })
    expect(workspaceTabsCollection.getRows()).toHaveLength(1)
    expect(workspaceViewStateCollection.getRows()[0]?.activeWorkspaceTabId).toBe('shell-1')

    await openWorkspaceTab({ workspaceId: 'workspace-1', tab: { id: 'browser-1', type: 'browser', url: 'https://example.com', title: 'Example' } })

    const rows = workspaceTabsCollection.getRows().sort((a, b) => a.position - b.position)
    expect(rows.map((row) => [row.id, row.position])).toEqual([['shell-1', 0], ['browser-1', 1]])
  })

  it('persists a new tab before making it active', async () => {
    applyWorkspaceTabRowsForTests([tabRecord({ id: 'shell-1', shellId: 'shell-1', position: 0 })])
    applyWorkspaceViewStateRowsForTests([viewState({ activeWorkspaceTabId: 'shell-1' })])
    const calls: string[] = []
    let finishTabWrite: ((record: WorkspaceTabRecord) => void) | undefined
    vi.mocked(appTrpcMutation).mockImplementation(async (procedure, _input) => {
      calls.push(procedure)
      if (procedure === 'workspace.upsertTab') {
        return await new Promise<WorkspaceTabRecord>((resolve) => {
          finishTabWrite = resolve
        })
      }
      return { ...viewState({}), activeWorkspaceTabId: 'diff-1' }
    })

    const opened = openWorkspaceTab({
      workspaceId: 'workspace-1',
      tab: { id: 'diff-1', type: 'git-diff', envId: 'env-1', repoRoot: '/repo', title: 'Git Diff' },
    })

    expect(getWorkspaceTabs('workspace-1').map((tab) => tab.id)).toEqual(['shell-1', 'diff-1'])
    expect(workspaceViewStateCollection.getRows()[0]?.activeWorkspaceTabId).toBe('shell-1')
    expect(calls).toEqual(['workspace.upsertTab'])

    finishTabWrite?.(tabRecord({ id: 'diff-1', type: 'git-diff', envId: 'env-1', repoRoot: '/repo', position: 1 }))
    await opened

    expect(calls).toEqual(['workspace.upsertTab', 'workspace.saveViewState'])
    expect(workspaceViewStateCollection.getRows()[0]?.activeWorkspaceTabId).toBe('diff-1')
  })

  it('deduplicates git diff tabs by environment and canonical repository root', async () => {
    applyWorkspaceTabRowsForTests([
      tabRecord({ id: 'diff-1', type: 'git-diff', envId: 'env-1', repoRoot: '/repo', position: 0 }),
    ])

    const existing = await openWorkspaceTabLocal({
      workspaceId: 'workspace-1',
      tab: { id: 'diff-duplicate', type: 'git-diff', envId: 'env-1', repoRoot: '/repo', title: 'Git Diff' },
    })
    await openWorkspaceTabLocal({
      workspaceId: 'workspace-1',
      tab: { id: 'diff-other-env', type: 'git-diff', envId: 'env-2', repoRoot: '/repo', title: 'Git Diff' },
    })
    await openWorkspaceTabLocal({
      workspaceId: 'workspace-1',
      tab: { id: 'diff-other-root', type: 'git-diff', envId: 'env-1', repoRoot: '/other', title: 'Git Diff' },
    })

    expect(existing.id).toBe('diff-1')
    expect(getWorkspaceTabs('workspace-1').map((tab) => tab.id)).toEqual(['diff-1', 'diff-other-env', 'diff-other-root'])
  })

  it('chooses active fallback on close and persists reorder positions', async () => {
    applyWorkspaceTabRowsForTests([
      tabRecord({ id: 'tab-1', position: 0, type: 'browser', url: 'https://one.example' }),
      tabRecord({ id: 'tab-2', position: 1, type: 'browser', url: 'https://two.example' }),
      tabRecord({ id: 'tab-3', position: 2, type: 'browser', url: 'https://three.example' }),
    ])
    applyWorkspaceViewStateRowsForTests([viewState({ activeWorkspaceTabId: 'tab-2' })])
    vi.mocked(appTrpcMutation).mockResolvedValue({ ok: true })

    await closeWorkspaceTab({ workspaceId: 'workspace-1', tabId: 'tab-2' })
    expect(workspaceViewStateCollection.getRows()[0]?.activeWorkspaceTabId).toBe('tab-3')
    expect(getWorkspaceTabs('workspace-1').map((tab) => tab.id)).toEqual(['tab-1', 'tab-3'])

    await reorderWorkspaceTabs({ workspaceId: 'workspace-1', tabIds: ['tab-3', 'tab-1'] })
    expect(workspaceTabsCollection.getRows().sort((a, b) => a.position - b.position).map((row) => row.id)).toEqual(['tab-3', 'tab-1'])
  })
})

describe('workspace search sync adapter', () => {
  it('applies chat/tab search params once per workspace and avoids URL loops after state matches', () => {
    expect(workspaceSearchSyncAction({
      firstApply: true,
      search: { chat: 'chat-1', tab: 'tab-1' },
      viewState: { activeAgentSessionId: null, activeWorkspaceTabId: null },
      tabIds: ['tab-1'],
    })).toEqual({ type: 'apply-search', sessionId: 'chat-1', tabId: 'tab-1' })

    expect(workspaceSearchSyncAction({
      firstApply: true,
      search: { tab: 'tab-1' },
      viewState: { activeAgentSessionId: null, activeWorkspaceTabId: null },
      tabIds: ['tab-1'],
    })).toEqual({ type: 'apply-search', tabId: 'tab-1' })

    expect(workspaceSearchSyncAction({
      firstApply: false,
      search: { chat: 'chat-1', tab: 'tab-1' },
      viewState: { activeAgentSessionId: 'chat-1', activeWorkspaceTabId: 'tab-1' },
      tabIds: ['tab-1'],
    })).toEqual({ type: 'none' })

    expect(workspaceSearchSyncAction({
      firstApply: false,
      search: { chat: 'old-chat', tab: 'old-tab' },
      viewState: { activeAgentSessionId: 'chat-2', activeWorkspaceTabId: 'tab-2' },
      tabIds: ['tab-2'],
    })).toEqual({ type: 'replace-url', chat: 'chat-2', tab: 'tab-2' })
  })
})

describe('workspace view state commands', () => {
  it('optimistically updates split ratio and reverts on backend failure', async () => {
    applyWorkspaceViewStateRowsForTests([viewState({ splitRatio: 0.7 })])
    vi.mocked(appTrpcMutation).mockRejectedValueOnce(new Error('view failed'))

    const promise = setWorkspaceSplitRatio({ workspaceId: 'workspace-1', splitRatio: 0.4 })
    expect(workspaceViewStateCollection.getRows()[0]?.splitRatio).toBe(0.4)
    await expect(promise).rejects.toThrow('view failed')

    expect(workspaceViewStateCollection.getRows()[0]?.splitRatio).toBe(0.7)
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

function tabRecord(input: Partial<WorkspaceTabRecord> & Pick<WorkspaceTabRecord, 'id'>): WorkspaceTabRecord {
  const type = input.type ?? 'shell'
  return {
    workspaceId: 'workspace-1',
    type,
    title: input.title ?? input.id,
    titleSource: type === 'shell' ? 'auto' : null,
    position: 0,
    envId: type === 'browser' ? null : 'env-1',
    shellId: type === 'shell' ? input.id : null,
    path: type === 'file' ? '/tmp/file.txt' : null,
    repoRoot: type === 'git-diff' ? '/repo' : null,
    sessionId: null,
    port: null,
    url: type === 'browser' ? 'https://example.com' : null,
    browserTabId: null,
    updatedAt: 1,
    ...input,
    faviconUrl: input.faviconUrl ?? null,
  }
}

function viewState(input: Partial<ReturnType<typeof workspaceViewStateCollection.getRows>[number]>): ReturnType<typeof workspaceViewStateCollection.getRows>[number] {
  return {
    workspaceId: 'workspace-1',
    activeAgentSessionId: null,
    activeWorkspaceTabId: null,
    splitRatio: null,
    agentCollapsed: false,
    updatedAt: 1,
    ...input,
  }
}
