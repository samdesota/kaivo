import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const exec = promisify(execFile)
let root = ''
let sqliteRaw: import('better-sqlite3').Database

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-config-request-'))
  vi.stubEnv('CC_STATE_DIR', root)
  vi.stubEnv('CC_WORKING_DIR', root)
  vi.stubEnv('CC_IDENTITY_URL', 'http://127.0.0.1:1')
  vi.resetModules()
  const [{ runMigrations }, client] = await Promise.all([import('../db/migrate.js'), import('../db/client.js')])
  sqliteRaw = client.sqliteRaw
  await runMigrations()
})

afterEach(async () => {
  if (sqliteRaw?.open) sqliteRaw.close()
  vi.unstubAllEnvs()
  vi.resetModules()
  await fs.rm(root, { recursive: true, force: true })
})

async function createSession(directory: string): Promise<void> {
  sqliteRaw.prepare(`
    INSERT INTO agent_sessions
      (id, workspace_id, opencode_session_id, status, kind, working_dir, created_at, last_activity_at)
    VALUES ('chat-1', 'workspace-1', 'oc-chat-1', 'active', 'chat', ?, datetime('now'), datetime('now'))
  `).run(directory)
}

async function waitForPending(service: { pending(workspaceId: string): unknown }): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (service.pending('workspace-1')) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('request did not become pending')
}

describe('RepoConfigRequestService', () => {
  it('pauses dispatch, stores a Git-root binding, and reuses it', async () => {
    const checkout = path.join(root, 'checkout')
    await fs.mkdir(checkout)
    await exec('git', ['init', checkout])
    await createSession(checkout)
    const { RepoConfigRequestService } = await import('./repo-config-request-service.js')
    const service = new RepoConfigRequestService()

    const resolving = service.resolveForDispatch({
      workspaceId: 'workspace-1', agentSessionId: 'chat-1', operationId: 'operation-1',
    })
    await waitForPending(service)
    const request = service.pending('workspace-1')!
    expect(request).toMatchObject({
      workingDir: checkout,
      repositoryRoot: await fs.realpath(checkout),
      status: 'pending',
    })
    expect(sqliteRaw.prepare('SELECT count(*) AS count FROM orchestration_subtasks').get()).toEqual({ count: 0 })

    service.claim({ workspaceId: 'workspace-1', requestId: request.id, claimId: 'claim-1' })
    service.complete({
      workspaceId: 'workspace-1', requestId: request.id, claimId: 'claim-1', configId: 'config-1',
    })
    await expect(resolving).resolves.toBe('config-1')
    await expect(service.resolveForDispatch({
      workspaceId: 'workspace-1', agentSessionId: 'chat-1', operationId: 'operation-2',
    })).resolves.toBe('config-1')
    expect(service.pending('workspace-1')).toBeNull()
  })

  it('cancels without reserving orchestration state', async () => {
    await createSession(root)
    const { RepoConfigRequestService } = await import('./repo-config-request-service.js')
    const service = new RepoConfigRequestService()
    const resolving = service.resolveForDispatch({
      workspaceId: 'workspace-1', agentSessionId: 'chat-1', operationId: 'operation-cancel',
    })
    await waitForPending(service)
    const request = service.pending('workspace-1')!
    service.claim({ workspaceId: 'workspace-1', requestId: request.id, claimId: 'claim-cancel' })
    service.cancel({ workspaceId: 'workspace-1', requestId: request.id, claimId: 'claim-cancel' })
    await expect(resolving).rejects.toThrow('repository setup was cancelled')
    expect(sqliteRaw.prepare('SELECT count(*) AS count FROM orchestration_subtasks').get()).toEqual({ count: 0 })
  })

  it('infers the longest configured managed checkout containing the session directory', async () => {
    const checkout = path.join(root, 'managed')
    const nested = path.join(checkout, 'packages', 'app')
    await fs.mkdir(nested, { recursive: true })
    await createSession(nested)
    sqliteRaw.prepare(`
      INSERT INTO repos
        (id, config_id, name, slug, worktree_name, worktree_slug, origin_url, ref, workspace_path, source, created_at)
      VALUES ('repo-1', 'config-managed', 'Managed', 'managed', 'Managed', 'managed', 'git@example.com:acme/repo.git', 'main', ?, 'url', datetime('now'))
    `).run(checkout)
    const { RepoConfigRequestService } = await import('./repo-config-request-service.js')
    const service = new RepoConfigRequestService()
    await expect(service.resolveForDispatch({
      workspaceId: 'workspace-1', agentSessionId: 'chat-1', operationId: 'operation-managed',
    })).resolves.toBe('config-managed')
    expect(service.pending('workspace-1')).toBeNull()
  })
})
