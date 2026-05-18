import { browserApi } from '../../lib/browser-api'
import type { WorkspaceResourceRecord } from './resources-store'

export type CleanupResourceRow = {
  id: string
  type: string
  label: string
  detail?: string
  shared: boolean
  orphan: boolean
  canCleanup: boolean
}

export type ResourceCleanupHandler = {
  exists(resource: WorkspaceResourceRecord): Promise<boolean>
  row(resource: WorkspaceResourceRecord): CleanupResourceRow
  cleanup(resource: WorkspaceResourceRecord): Promise<void>
}

export type WorkspaceResourceCleanupRegistry = {
  handlerFor(type: string): ResourceCleanupHandler
}

export type WorkspaceResourceCleanupServices = {
  workspaceId: string
  resources: WorkspaceResourceRecord[]
  listShells: () => Promise<Array<{ id: string }>>
  disposeShell: (id: string) => Promise<unknown>
  listWorktrees: () => Promise<Array<{ id: string; workingDir: string }>>
  deleteWorktree: (repoId: string) => Promise<unknown>
}

export function createWorkspaceResourceCleanupRegistry(services: WorkspaceResourceCleanupServices): WorkspaceResourceCleanupRegistry {
  let browserTabIds: Promise<Set<string>> | null = null
  let shellIds: Promise<Set<string>> | null = null
  let worktreeKeys: Promise<Set<string>> | null = null

  function getBrowserTabIds(): Promise<Set<string>> {
    browserTabIds ??= browserApi.isAvailable()
      ? browserApi.listTabs().then((tabs) => new Set(tabs.map((tab) => tab.browserTabId))).catch(() => new Set<string>())
      : Promise.resolve(new Set<string>())
    return browserTabIds
  }

  function getShellIds(): Promise<Set<string>> {
    shellIds ??= services.listShells().then((shells) => new Set(shells.map((shell) => shell.id))).catch(() => new Set<string>())
    return shellIds
  }

  function getWorktreeKeys(): Promise<Set<string>> {
    worktreeKeys ??= services.listWorktrees().then((worktrees) => {
      const keys = new Set<string>()
      for (const worktree of worktrees) {
        keys.add(`repo:${worktree.id}`)
        keys.add(`path:${worktree.workingDir}`)
      }
      return keys
    }).catch(() => new Set<string>())
    return worktreeKeys
  }

  function isSharedResourceOrphan(resource: WorkspaceResourceRecord): boolean {
    return !services.resources.some((candidate) => {
      return candidate.workspaceId !== services.workspaceId && candidate.type === resource.type && candidate.resourceKey === resource.resourceKey
    })
  }

  const handlers: Record<string, ResourceCleanupHandler> & { other: ResourceCleanupHandler } = {
    browser_tab: {
      async exists(resource) {
        return (await getBrowserTabIds()).has(browserTabId(resource))
      },
      row(resource) {
        return { id: resource.id, type: 'browser', label: browserTabId(resource), shared: false, orphan: false, canCleanup: true }
      },
      async cleanup(resource) {
        if (!browserApi.isAvailable()) return
        await ignoreAlreadyCleaned(browserApi.closeTab({ browserTabId: browserTabId(resource) }))
      },
    },
    shell: {
      async exists(resource) {
        return (await getShellIds()).has(shellId(resource))
      },
      row(resource) {
        return { id: resource.id, type: 'shell', label: shellId(resource), shared: false, orphan: false, canCleanup: true }
      },
      async cleanup(resource) {
        await ignoreAlreadyCleaned(services.disposeShell(shellId(resource)))
      },
    },
    worktree: {
      async exists(resource) {
        const keys = await getWorktreeKeys()
        return worktreeKeysFor(resource).some((key) => keys.has(key))
      },
      row(resource) {
        const orphan = resource.shared ? isSharedResourceOrphan(resource) : false
        return {
          id: resource.id,
          type: 'worktree',
          label: resourceLabel(resource),
          detail: resource.resourceKey,
          shared: resource.shared,
          orphan,
          canCleanup: !resource.shared || orphan,
        }
      },
      async cleanup(resource) {
        const repoId = worktreeRepoId(resource)
        if (!repoId) return
        await ignoreAlreadyCleaned(services.deleteWorktree(repoId))
      },
    },
    other: {
      async exists() {
        return true
      },
      row(resource) {
        const orphan = resource.shared ? isSharedResourceOrphan(resource) : false
        return {
          id: resource.id,
          type: resource.type,
          label: resourceLabel(resource),
          detail: resource.resourceKey,
          shared: resource.shared,
          orphan,
          canCleanup: !resource.shared || orphan,
        }
      },
      async cleanup() {},
    },
  }

  return {
    handlerFor(type) {
      return handlers[type] ?? handlers.other
    },
  }
}

function browserTabId(resource: WorkspaceResourceRecord): string {
  return String(resource.data.browserTabId ?? resource.resourceKey)
}

function shellId(resource: WorkspaceResourceRecord): string {
  return String(resource.data.shellId ?? resource.resourceKey)
}

function worktreeRepoId(resource: WorkspaceResourceRecord): string | null {
  return typeof resource.data.repoId === 'string'
    ? resource.data.repoId
    : resource.resourceKey.startsWith('repo:')
      ? resource.resourceKey.slice(5)
      : null
}

function worktreeKeysFor(resource: WorkspaceResourceRecord): string[] {
  const keys = [resource.resourceKey]
  const repoId = worktreeRepoId(resource)
  if (repoId) keys.push(`repo:${repoId}`)
  if (typeof resource.data.workingDir === 'string') keys.push(`path:${resource.data.workingDir}`)
  return keys
}

function resourceLabel(resource: WorkspaceResourceRecord): string {
  if (typeof resource.data.title === 'string') return resource.data.title
  if (typeof resource.data.name === 'string') return resource.data.name
  if (typeof resource.data.workingDir === 'string') return resource.data.workingDir
  return `${resource.type}:${resource.resourceKey}`
}

async function ignoreAlreadyCleaned(promise: Promise<unknown>): Promise<void> {
  try {
    await promise
  } catch (error) {
    const message = (error as { message?: string })?.message ?? ''
    if (/not[_ -]?found|no longer|missing|does not exist|not running/i.test(message)) return
    throw error
  }
}
