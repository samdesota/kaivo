import fs from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../db/client.js'
import { sandboxes, type SandboxStatus } from '../db/schema.js'
import { env } from '../env.js'
import { logger } from '../logger.js'
import { ensureNetwork, getDocker } from '../docker/client.js'
import {
  SANDBOX_LABEL,
  opencodeDir,
  opencodeHostDir,
  sandboxRootDir,
  workspaceDir,
  workspaceHostDir,
} from './paths.js'

export interface SandboxSummary {
  id: string
  name: string
  status: SandboxStatus
  containerId: string | null
  createdAt: Date
  archivedAt: Date | null
  running: boolean
  workspacePath: string
}

export class SandboxError extends Error {
  constructor(
    public code:
      | 'not_found'
      | 'name_required'
      | 'docker_unavailable'
      | 'invalid_state',
    message: string,
  ) {
    super(message)
    this.name = 'SandboxError'
  }
}

export interface SandboxEvent {
  type: 'created' | 'archived' | 'deleted' | 'status_changed'
  sandboxId: string
  status?: SandboxStatus
}

type Listener = (evt: SandboxEvent) => void

class SandboxManager {
  private listeners = new Set<Listener>()

  onEvent(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(evt: SandboxEvent): void {
    for (const l of this.listeners) {
      try {
        l(evt)
      } catch (err) {
        logger.warn({ err }, 'sandbox listener threw')
      }
    }
  }

  async create(opts: { name: string }): Promise<SandboxSummary> {
    const name = opts.name.trim()
    if (!name) throw new SandboxError('name_required', 'name is required')

    const id = ulid().toLowerCase()
    const root = sandboxRootDir(id)
    await fs.mkdir(workspaceDir(id), { recursive: true })
    await fs.mkdir(opencodeDir(id), { recursive: true })

    await db.insert(sandboxes).values({ id, name, status: 'active' })

    try {
      await ensureNetwork(env.DOCKER_NETWORK)
      const container = await this.createContainer(id)
      await container.start()
      await db
        .update(sandboxes)
        .set({ containerId: container.id })
        .where(eq(sandboxes.id, id))
      logger.info({ id, containerId: container.id }, 'sandbox started')
    } catch (err) {
      logger.error({ err, id }, 'sandbox container start failed')
      await db
        .update(sandboxes)
        .set({ status: 'crashed' })
        .where(eq(sandboxes.id, id))
      // Leave workspace intact so the operator can inspect.
      throw new SandboxError('docker_unavailable', describeDockerError(err))
    }

    this.emit({ type: 'created', sandboxId: id })
    const summary = await this.get(id)
    if (!summary) throw new SandboxError('not_found', 'sandbox vanished after create')
    return summary
    void root
  }

  private async createContainer(id: string) {
    const d = getDocker()
    return d.createContainer({
      Image: env.SANDBOX_BASE_IMAGE,
      name: `coding-env-sandbox-${id}`,
      Labels: { [SANDBOX_LABEL]: id },
      User: '1000:1000',
      WorkingDir: '/workspace',
      Cmd: ['tail', '-f', '/dev/null'],
      Tty: false,
      OpenStdin: false,
      HostConfig: {
        Binds: [
          `${workspaceHostDir(id)}:/workspace`,
          `${opencodeHostDir(id)}:/home/coder/.opencode`,
        ],
        NetworkMode: env.DOCKER_NETWORK,
        ReadonlyRootfs: true,
        Tmpfs: {
          '/tmp': 'rw,nosuid,size=256m',
          '/run': 'rw,nosuid,size=64m',
          '/home/coder': 'rw,nosuid,size=512m,uid=1000,gid=1000',
        },
        Memory: 4 * 1024 * 1024 * 1024, // 4 GiB
        NanoCpus: 2 * 1_000_000_000,
        PidsLimit: 512,
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['ALL'],
        AutoRemove: false,
      },
    })
  }

  async list(): Promise<SandboxSummary[]> {
    const rows = await db.select().from(sandboxes)
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    const out: SandboxSummary[] = []
    for (const r of rows) {
      const running = await this.isRunning(r.containerId)
      out.push({
        id: r.id,
        name: r.name,
        status: r.status,
        containerId: r.containerId,
        createdAt: r.createdAt,
        archivedAt: r.archivedAt,
        running,
        workspacePath: workspaceDir(r.id),
      })
    }
    return out
  }

  async get(id: string): Promise<SandboxSummary | null> {
    const rows = await db.select().from(sandboxes).where(eq(sandboxes.id, id)).limit(1)
    const row = rows[0]
    if (!row) return null
    const running = await this.isRunning(row.containerId)
    return {
      id: row.id,
      name: row.name,
      status: row.status,
      containerId: row.containerId,
      createdAt: row.createdAt,
      archivedAt: row.archivedAt,
      running,
      workspacePath: workspaceDir(row.id),
    }
  }

  async archive(id: string): Promise<void> {
    const row = await this.requireRow(id)
    if (row.containerId) {
      await this.stopContainerSafe(row.containerId)
    }
    await db
      .update(sandboxes)
      .set({ status: 'archived', containerId: null, archivedAt: new Date() })
      .where(eq(sandboxes.id, id))
    this.emit({ type: 'archived', sandboxId: id, status: 'archived' })
  }

  async delete(id: string): Promise<void> {
    const row = await this.requireRow(id)
    if (row.containerId) {
      await this.stopContainerSafe(row.containerId, true)
    } else {
      // Container may still exist if archive left an orphan — try label match.
      await this.removeByLabel(id)
    }
    await db.delete(sandboxes).where(eq(sandboxes.id, id))
    try {
      await fs.rm(sandboxRootDir(id), { recursive: true, force: true })
    } catch (err) {
      logger.warn({ err, id }, 'sandbox dir rm failed')
    }
    this.emit({ type: 'deleted', sandboxId: id })
  }

  async restart(id: string): Promise<void> {
    const row = await this.requireRow(id)
    if (row.status === 'archived') {
      throw new SandboxError('invalid_state', 'cannot restart archived sandbox')
    }
    // Remove any crashed container, start a new one.
    await this.removeByLabel(id)
    const container = await this.createContainer(id)
    await container.start()
    await db
      .update(sandboxes)
      .set({ containerId: container.id, status: 'active' })
      .where(eq(sandboxes.id, id))
    this.emit({ type: 'status_changed', sandboxId: id, status: 'active' })
  }

  /**
   * On boot: look for containers with our label; bind them back to their DB
   * rows; start stopped ones; mark missing ones crashed.
   */
  async reconcile(): Promise<void> {
    const d = getDocker()
    let containers: Awaited<ReturnType<typeof d.listContainers>> = []
    try {
      containers = await d.listContainers({
        all: true,
        filters: { label: [`${SANDBOX_LABEL}`] },
      })
    } catch (err) {
      logger.warn({ err }, 'reconcile listContainers failed')
      return
    }

    const byId = new Map<string, (typeof containers)[number]>()
    for (const c of containers) {
      const sid = c.Labels?.[SANDBOX_LABEL]
      if (sid) byId.set(sid, c)
    }

    const rows = await db.select().from(sandboxes)
    for (const r of rows) {
      if (r.status === 'archived') continue
      const c = byId.get(r.id)
      if (!c) {
        if (r.containerId || r.status !== 'crashed') {
          await db
            .update(sandboxes)
            .set({ status: 'crashed', containerId: null })
            .where(eq(sandboxes.id, r.id))
          this.emit({ type: 'status_changed', sandboxId: r.id, status: 'crashed' })
        }
        continue
      }
      if (c.State !== 'running') {
        try {
          await d.getContainer(c.Id).start()
        } catch (err) {
          logger.warn({ err, id: r.id }, 'reconcile start failed')
        }
      }
      if (r.containerId !== c.Id || r.status !== 'active') {
        await db
          .update(sandboxes)
          .set({ containerId: c.Id, status: 'active' })
          .where(eq(sandboxes.id, r.id))
        this.emit({ type: 'status_changed', sandboxId: r.id, status: 'active' })
      }
    }
  }

  private async requireRow(id: string) {
    const rows = await db.select().from(sandboxes).where(eq(sandboxes.id, id)).limit(1)
    const row = rows[0]
    if (!row) throw new SandboxError('not_found', `sandbox ${id} not found`)
    return row
  }

  private async isRunning(containerId: string | null): Promise<boolean> {
    if (!containerId) return false
    try {
      const info = await getDocker().getContainer(containerId).inspect()
      return info.State.Running === true
    } catch {
      return false
    }
  }

  private async stopContainerSafe(containerId: string, remove = false): Promise<void> {
    const c = getDocker().getContainer(containerId)
    try {
      await c.stop({ t: 5 })
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode
      if (code !== 304 && code !== 404) logger.warn({ err }, 'container stop failed')
    }
    if (remove) {
      try {
        await c.remove({ force: true })
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode
        if (code !== 404) logger.warn({ err }, 'container remove failed')
      }
    }
  }

  private async removeByLabel(sandboxId: string): Promise<void> {
    const d = getDocker()
    try {
      const list = await d.listContainers({
        all: true,
        filters: { label: [`${SANDBOX_LABEL}=${sandboxId}`] },
      })
      for (const c of list) {
        try {
          await d.getContainer(c.Id).remove({ force: true })
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode
          if (code !== 404) logger.warn({ err, id: sandboxId }, 'label remove failed')
        }
      }
    } catch (err) {
      logger.warn({ err, id: sandboxId }, 'label list failed')
    }
  }
}

function describeDockerError(err: unknown): string {
  const msg = (err as { message?: string }).message ?? String(err)
  const code = (err as { code?: string }).code
  if (code === 'ENOENT' || msg.includes('/var/run/docker.sock')) {
    return 'docker socket not reachable — mount /var/run/docker.sock into the app container'
  }
  return `docker error: ${msg}`
}

export const sandboxManager = new SandboxManager()
