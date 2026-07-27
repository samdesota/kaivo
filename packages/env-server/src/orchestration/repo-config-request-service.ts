import path from 'node:path'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import { agentSessions, orchestrationRepoConfigBindings, orchestrationRepoConfigRequests, repos } from '../db/schema.js'
import { db, sqliteRaw } from '../db/client.js'
import { gitService } from '../git/service.js'
import type { RepoConfigRequestSummary } from './contracts.js'

export class RepoConfigRequestError extends Error {
  constructor(
    public readonly code: 'not_found' | 'conflict' | 'invalid_state',
    message: string,
  ) {
    super(message)
    this.name = 'RepoConfigRequestError'
  }
}

const CLAIM_TTL_MS = 2 * 60_000
const REQUEST_TIMEOUT_MS = 5 * 60_000
const waiters = new Map<string, Set<() => void>>()

function now(): string {
  return new Date().toISOString()
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function wake(requestId: string): void {
  for (const resolve of waiters.get(requestId) ?? []) resolve()
  waiters.delete(requestId)
}

function waitForChange(requestId: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const listeners = waiters.get(requestId) ?? new Set<() => void>()
    let timer: ReturnType<typeof setTimeout>
    const done = () => {
      clearTimeout(timer)
      listeners.delete(done)
      if (listeners.size === 0) waiters.delete(requestId)
      resolve()
    }
    listeners.add(done)
    waiters.set(requestId, listeners)
    timer = setTimeout(done, timeoutMs)
  })
}

type RequestRow = typeof orchestrationRepoConfigRequests.$inferSelect

export class RepoConfigRequestService {
  async resolveForDispatch(input: {
    workspaceId: string
    agentSessionId: string
    operationId: string
  }): Promise<string> {
    const session = db.select().from(agentSessions).where(eq(agentSessions.id, input.agentSessionId)).limit(1).all()[0]
    if (!session || session.workspaceId !== input.workspaceId) {
      throw new RepoConfigRequestError('not_found', 'agent session not found')
    }
    const workingDir = session.workingDir ?? process.env.CC_WORKING_DIR
    if (!workingDir) throw new RepoConfigRequestError('invalid_state', 'agent session has no working directory')
    const repository = await gitService.discoverGit(workingDir)
    const repositoryRoot = repository?.root ?? null

    const inferred = this.inferConfigId(repositoryRoot ?? workingDir, input.workspaceId)
    if (inferred) return inferred

    const request = sqliteRaw.transaction(() => {
      const existing = db.select().from(orchestrationRepoConfigRequests).where(and(
        eq(orchestrationRepoConfigRequests.agentSessionId, input.agentSessionId),
        eq(orchestrationRepoConfigRequests.operationId, input.operationId),
      )).limit(1).all()[0]
      if (existing) return existing
      const timestamp = now()
      const id = ulid().toLowerCase()
      db.insert(orchestrationRepoConfigRequests).values({
        id,
        operationId: input.operationId,
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        workingDir,
        repositoryRoot,
        status: 'pending',
        createdAt: timestamp,
        updatedAt: timestamp,
      }).run()
      return db.select().from(orchestrationRepoConfigRequests).where(eq(orchestrationRepoConfigRequests.id, id)).get()!
    })()
    return this.waitForResolution(request)
  }

  pending(workspaceId: string): RepoConfigRequestSummary | null {
    const rows = db.select().from(orchestrationRepoConfigRequests).where(and(
      eq(orchestrationRepoConfigRequests.workspaceId, workspaceId),
      inArray(orchestrationRepoConfigRequests.status, ['pending', 'claimed']),
    )).orderBy(asc(orchestrationRepoConfigRequests.createdAt)).all()
    const timestamp = Date.now()
    const row = rows.find((candidate) => candidate.status === 'pending'
      || !candidate.claimedAt
      || timestamp - Date.parse(candidate.claimedAt) >= CLAIM_TTL_MS)
    return row ? this.summary(row) : null
  }

  claim(input: { workspaceId: string; requestId: string; claimId: string }): RepoConfigRequestSummary {
    const timestamp = now()
    const staleBefore = new Date(Date.now() - CLAIM_TTL_MS).toISOString()
    const result = sqliteRaw.prepare(`
      UPDATE orchestration_repo_config_requests
      SET status = 'claimed', claim_id = ?, claimed_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?
        AND (status = 'pending' OR (status = 'claimed' AND (claimed_at IS NULL OR claimed_at <= ?)))
    `).run(input.claimId, timestamp, timestamp, input.requestId, input.workspaceId, staleBefore)
    if (result.changes !== 1) throw new RepoConfigRequestError('conflict', 'repository setup request is already claimed')
    return this.summary(this.requireRequest(input.requestId, input.workspaceId))
  }

  complete(input: { workspaceId: string; requestId: string; claimId: string; configId: string }): void {
    const row = this.requireClaim(input)
    const timestamp = now()
    sqliteRaw.transaction(() => {
      const bindingRoot = row.repositoryRoot ?? path.resolve(row.workingDir)
      if (bindingRoot) {
        db.insert(orchestrationRepoConfigBindings).values({
          repositoryRoot: bindingRoot,
          configId: input.configId,
          createdAt: timestamp,
          updatedAt: timestamp,
        }).onConflictDoUpdate({
          target: orchestrationRepoConfigBindings.repositoryRoot,
          set: { configId: input.configId, updatedAt: timestamp },
        }).run()
      }
      db.update(orchestrationRepoConfigRequests).set({
        status: 'completed', configId: input.configId, updatedAt: timestamp,
      }).where(eq(orchestrationRepoConfigRequests.id, row.id)).run()
    })()
    wake(row.id)
  }

  cancel(input: { workspaceId: string; requestId: string; claimId: string }): void {
    const row = this.requireClaim(input)
    db.update(orchestrationRepoConfigRequests).set({ status: 'cancelled', updatedAt: now() })
      .where(eq(orchestrationRepoConfigRequests.id, row.id)).run()
    wake(row.id)
  }

  private inferConfigId(directory: string, workspaceId: string): string | null {
    const binding = db.select().from(orchestrationRepoConfigBindings)
      .where(eq(orchestrationRepoConfigBindings.repositoryRoot, path.resolve(directory))).limit(1).all()[0]
    if (binding) return binding.configId
    const candidates = db.select().from(repos).all()
      .filter((repo) => repo.configId && containsPath(repo.workspacePath, directory)
        && (!repo.workspaceId || repo.workspaceId === workspaceId))
      .sort((a, b) => b.workspacePath.length - a.workspacePath.length)
    return candidates[0]?.configId ?? null
  }

  private async waitForResolution(initial: RequestRow): Promise<string> {
    const deadline = Date.now() + REQUEST_TIMEOUT_MS
    let row = initial
    while (true) {
      if (row.status === 'completed' && row.configId) return row.configId
      if (row.status === 'cancelled') throw new RepoConfigRequestError('invalid_state', 'repository setup was cancelled')
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new RepoConfigRequestError('invalid_state', 'repository setup timed out')
      await waitForChange(row.id, Math.min(remaining, 1_000))
      row = this.requireRequest(row.id, row.workspaceId)
    }
  }

  private requireRequest(requestId: string, workspaceId: string): RequestRow {
    const row = db.select().from(orchestrationRepoConfigRequests).where(and(
      eq(orchestrationRepoConfigRequests.id, requestId),
      eq(orchestrationRepoConfigRequests.workspaceId, workspaceId),
    )).limit(1).all()[0]
    if (!row) throw new RepoConfigRequestError('not_found', 'repository setup request not found')
    return row
  }

  private requireClaim(input: { workspaceId: string; requestId: string; claimId: string }): RequestRow {
    const row = this.requireRequest(input.requestId, input.workspaceId)
    if (row.status !== 'claimed' || row.claimId !== input.claimId) {
      throw new RepoConfigRequestError('conflict', 'repository setup request claim is no longer active')
    }
    return row
  }

  private summary(row: RequestRow): RepoConfigRequestSummary {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      workingDir: row.workingDir,
      repositoryRoot: row.repositoryRoot,
      status: row.status === 'claimed' ? 'claimed' : 'pending',
      createdAt: row.createdAt,
    }
  }
}

export const repoConfigRequestService = new RepoConfigRequestService()
