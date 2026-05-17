import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { request as undiciRequest } from 'undici'
import { ulid } from 'ulid'
import { db } from '../db/client.js'
import { envs, type EnvKind, type EnvStatus } from '../db/schema.js'
import { env } from '../env.js'
import { issueEnvAuthToken, revokeEnvAuthToken } from '../envauth/service.js'
import { ensureNetwork, getDocker } from '../docker/client.js'
import { logger } from '../logger.js'
import {
  ENV_CONTAINER_LABEL,
  containerNameForEnv,
  envRootDir,
  envStateDir,
  envStateHostDir,
  envWorkspaceDir,
  envWorkspaceHostDir,
} from './paths.js'

export class EnvError extends Error {
  constructor(
    public code:
      | 'not_found'
      | 'invalid_state'
      | 'docker_unavailable'
      | 'unreachable'
      | 'label_required'
      | 'url_required',
    message: string,
  ) {
    super(message)
    this.name = 'EnvError'
  }
}

export interface EnvSummary {
  id: string
  kind: EnvKind
  label: string
  url: string
  envToken: string | null
  localIdentityLabel: string | null
  status: EnvStatus
  containerId: string | null
  createdAt: Date
  archivedAt: Date | null
  lastSeenAt: Date | null
}

const ENV_PORT = 47821
const HEALTH_PROBE_TIMEOUT_MS = 3000

function randomEnvToken(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function hashEnvToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function summarize(row: typeof envs.$inferSelect): EnvSummary {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    url: row.url,
    envToken: row.envToken,
    localIdentityLabel: row.localIdentityLabel,
    status: row.status,
    containerId: row.containerId,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
    lastSeenAt: row.lastSeenAt,
  }
}

class EnvManager {
  async list(opts: { localIdentityLabel?: string | null } = {}): Promise<EnvSummary[]> {
    const rows = await db.select().from(envs)
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    return rows
      .filter((row) => {
        if (row.kind !== 'local') return true
        if (!opts.localIdentityLabel) return false
        return row.localIdentityLabel === opts.localIdentityLabel
      })
      .map(summarize)
  }

  async get(
    id: string,
    opts: { localIdentityLabel?: string | null } = {},
  ): Promise<EnvSummary | null> {
    const row = await this.getRow(id)
    if (row?.kind === 'local' && row.localIdentityLabel !== opts.localIdentityLabel) {
      return null
    }
    return row ? summarize(row) : null
  }

  /**
   * Create a new container-kind env. Mints identityToken + envToken, spins up
   * a container with both in its environment, waits for /healthz, returns
   * envToken exactly once to the caller so it can be cached in the webapp.
   */
  async createContainer({
    label,
  }: {
    label: string
  }): Promise<{ env: EnvSummary; envToken: string }> {
    const trimmed = label.trim()
    if (!trimmed) throw new EnvError('label_required', 'label is required')

    const id = ulid().toLowerCase()
    // Make workspace + state dirs before the container claims them.
    await fs.mkdir(envWorkspaceDir(id), { recursive: true })
    await fs.mkdir(envStateDir(id), { recursive: true })
    try {
      await fs.chown(envWorkspaceDir(id), 1000, 1000)
      await fs.chown(envStateDir(id), 1000, 1000)
    } catch {
      // best-effort; app may not be running as root
    }

    const envToken = randomEnvToken()
    const envTokenHash = hashEnvToken(envToken)
    const identity = await issueEnvAuthToken(`container:${id}`, 'service')

    // Relative URL — cc-control's /env/:id/* reverse proxy resolves this
    // to the container. Webapp builds absolute URLs from window.origin.
    const url = `/env/${id}`

    await db.insert(envs).values({
      id,
      kind: 'container',
      label: trimmed,
      url,
      status: 'running',
      identityTokenHash: identity.tokenHash,
    })

    try {
      await ensureNetwork(env.DOCKER_NETWORK)
      const container = await this.createDockerContainer({
        envId: id,
        envTokenHash, // stored inside cc-env; only hash is needed by orchestrator
        envToken,
        identityToken: identity.token,
      })
      await container.start()
      await db
        .update(envs)
        .set({ containerId: container.id })
        .where(eq(envs.id, id))
      logger.info({ envId: id, containerId: container.id }, 'env container started')
      // Wait for cc-env to respond on /healthz so the webapp's first token
      // test succeeds. Best-effort: if the probe times out we still return
      // the env — periodic probeHealth will catch it up.
      await this.waitForHealthz(id, container.id).catch((err) => {
        logger.warn({ err, envId: id }, 'env healthz wait failed')
      })
    } catch (err) {
      logger.error({ err, envId: id }, 'env container start failed')
      await db.update(envs).set({ status: 'crashed' }).where(eq(envs.id, id))
      throw new EnvError('docker_unavailable', describeDockerError(err))
    }

    const row = await this.requireRow(id)
    return { env: summarize(row), envToken }
  }

  private async waitForHealthz(envId: string, containerId: string): Promise<void> {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      try {
        const info = await getDocker().getContainer(containerId).inspect()
        const ip =
          info.NetworkSettings?.Networks?.[env.DOCKER_NETWORK]?.IPAddress ??
          null
        if (ip) {
          const res = await undiciRequest(`http://${ip}:${ENV_PORT}/healthz`, {
            method: 'GET',
            headersTimeout: 2_000,
            bodyTimeout: 2_000,
          })
          await res.body.dump()
          if (res.statusCode >= 200 && res.statusCode < 400) {
            await db
              .update(envs)
              .set({ lastSeenAt: new Date() })
              .where(eq(envs.id, envId))
            return
          }
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new EnvError('unreachable', `env ${envId} /healthz did not respond`)
  }

  /**
   * Register an already-running local env (user ran install.sh + paired).
   * Orchestrator stores the local browser token, scoped by the install label,
   * so all browsers on the same computer can use the env without re-pairing.
   */
  async registerLocal({
    url,
    envToken,
    label,
    localIdentityLabel,
  }: {
    url: string
    envToken: string
    label: string
    localIdentityLabel: string
  }): Promise<EnvSummary> {
    const trimmed = label.trim()
    const trimmedIdentityLabel = localIdentityLabel.trim()
    if (!trimmed) throw new EnvError('label_required', 'label is required')
    if (!trimmedIdentityLabel) throw new EnvError('label_required', 'local identity label is required')
    if (!url) throw new EnvError('url_required', 'url is required')

    // No reachability probe: a local env URL like http://127.0.0.1:47821
    // is only reachable from the user's machine, which is the browser.
    // The browser already verified the env + token by completing
    // pair.start / pair.confirm before calling here.

    const id = ulid().toLowerCase()
    await db.insert(envs).values({
      id,
      kind: 'local',
      label: trimmed,
      url,
      envToken,
      localIdentityLabel: trimmedIdentityLabel,
      status: 'running',
      lastSeenAt: new Date(),
    })

    const row = await this.requireRow(id)
    return summarize(row)
  }

  async archive(id: string): Promise<void> {
    const row = await this.requireRow(id)
    if (row.kind !== 'container') {
      throw new EnvError('invalid_state', 'only container envs support archive')
    }
    if (row.containerId) await this.stopContainerSafe(row.containerId, false)
    await db
      .update(envs)
      .set({ status: 'archived', containerId: null, archivedAt: new Date() })
      .where(eq(envs.id, id))
  }

  async delete(id: string): Promise<void> {
    const row = await this.requireRow(id)
    if (row.kind === 'container') {
      if (row.containerId) await this.stopContainerSafe(row.containerId, true)
      else await this.removeByLabel(id)
    }
    if (row.identityTokenHash) {
      try {
        await revokeEnvAuthToken(row.identityTokenHash)
      } catch (err) {
        logger.warn({ err, envId: id }, 'identity token revoke failed')
      }
    }
    await db.delete(envs).where(eq(envs.id, id))
    if (row.kind === 'container') {
      try {
        await fs.rm(envRootDir(id), { recursive: true, force: true })
      } catch (err) {
        logger.warn({ err, envId: id }, 'env dir rm failed')
      }
    }
  }

  async restart(id: string): Promise<void> {
    const row = await this.requireRow(id)
    if (row.kind !== 'container') {
      throw new EnvError('invalid_state', 'only container envs support restart')
    }
    if (row.status === 'archived') {
      throw new EnvError('invalid_state', 'cannot restart archived env')
    }
    await this.removeByLabel(id)
    await fs.mkdir(envWorkspaceDir(id), { recursive: true })
    await fs.mkdir(envStateDir(id), { recursive: true })

    // Mint fresh tokens — old ones are invalidated. The envToken change is
    // surfaced via the return of a future "rotate" flow; for now, callers
    // who restart must re-fetch envToken out of band. (The webapp caches it
    // in localStorage and will need to handle 401s on restart.)
    // To keep v1 simple: reuse the existing identity token (do NOT rotate),
    // and mint a *new* envToken that the container re-reads from its SQLite
    // on boot via the secrets file.
    //
    // TODO(v2): fold a rotate into the restart RPC so the webapp can
    // refresh its cached envToken atomically.
    if (!row.identityTokenHash) {
      throw new EnvError(
        'invalid_state',
        'env has no identity token; delete + recreate',
      )
    }
    // We lost the raw identity token on first create; container reads it
    // from its own state dir (secrets file we wrote at create time). So we
    // don't need to re-inject it here — the container's on-disk state
    // carries it across restarts.
    const container = await this.createDockerContainerOnRestart({
      envId: id,
    })
    await container.start()
    await db
      .update(envs)
      .set({ containerId: container.id, status: 'running' })
      .where(eq(envs.id, id))
  }

  async probeHealth(id: string): Promise<{ status: EnvStatus; lastSeenAt: Date | null }> {
    const row = await this.requireRow(id)
    const url = absoluteUrlFromEnv(row.url)
    const ok = await probeHealthzUnauthed(url)
    const now = new Date()
    const nextStatus: EnvStatus = ok
      ? 'running'
      : row.status === 'archived'
        ? 'archived'
        : 'unreachable'
    if (ok) {
      await db
        .update(envs)
        .set({ status: nextStatus, lastSeenAt: now })
        .where(eq(envs.id, id))
    } else if (nextStatus !== row.status) {
      await db.update(envs).set({ status: nextStatus }).where(eq(envs.id, id))
    }
    return { status: nextStatus, lastSeenAt: ok ? now : row.lastSeenAt }
  }

  async unregister(id: string): Promise<void> {
    const row = await this.requireRow(id)
    if (row.kind !== 'local') {
      throw new EnvError('invalid_state', 'unregister is for local envs — use delete for container envs')
    }
    await db.delete(envs).where(eq(envs.id, id))
  }

  // --- private ----------------------------------------------------------

  private async requireRow(id: string) {
    const row = await this.getRow(id)
    if (!row) throw new EnvError('not_found', `env ${id} not found`)
    return row
  }

  private async getRow(id: string) {
    const rows = await db.select().from(envs).where(eq(envs.id, id)).limit(1)
    return rows[0] ?? null
  }

  private async createDockerContainer(opts: {
    envId: string
    envTokenHash: string
    envToken: string
    identityToken: string
  }) {
    // Write the secrets file now so the container sees it on first boot.
    // envToken is hashed inside cc-env, but we need to pass the raw token
    // once so cc-env can record the hash. Same for identityToken (used at
    // runtime to call identity).
    const secretsPath = `${envStateDir(opts.envId)}/secrets.json`
    await fs.writeFile(
      secretsPath,
      JSON.stringify({
        envToken: opts.envToken,
        identityToken: opts.identityToken,
      }),
      { mode: 0o600 },
    )
    try {
      await fs.chown(secretsPath, 1000, 1000)
    } catch {
      // best-effort
    }

    return this.createDockerContainerOnRestart({ envId: opts.envId })
  }

  private async createDockerContainerOnRestart(opts: { envId: string }) {
    const d = getDocker()
    const pluginHost = env.DEV_PLUGIN_HOST_PATH
    const devBinds = pluginHost ? [`${pluginHost}:/opt/kaivo-opencode-plugin:ro`] : []
    const sshBinds = env.SANDBOX_SSH_DIR
      ? [`${env.SANDBOX_SSH_DIR}:/home/coder/.ssh:ro`]
      : []
    const dockerSockBinds = env.SANDBOX_DOCKER_SOCK
      ? ['/var/run/docker.sock:/var/run/docker.sock']
      : []
    const dockerSockGroups = env.SANDBOX_DOCKER_SOCK
      ? [String(env.SANDBOX_DOCKER_SOCK_GID)]
      : []

    return d.createContainer({
      Image: env.SANDBOX_BASE_IMAGE,
      name: containerNameForEnv(opts.envId),
      Labels: { [ENV_CONTAINER_LABEL]: opts.envId },
      User: '1000:1000',
      WorkingDir: '/workspace',
      // The image CMD already runs cc-env; we override here so a future
      // rev can swap to a wrapper (e.g. supervisord) without rebuilding.
      Cmd: ['node', '/opt/cc-env/main.js'],
      Tty: false,
      OpenStdin: false,
      Env: [
        `CC_WORKING_DIR=/workspace`,
        `CC_PORT=${ENV_PORT}`,
        `CC_HOST=0.0.0.0`,
        `CC_IDENTITY_URL=${env.SANDBOX_APP_URL}`,
        `CC_STATE_DIR=/var/lib/cc-env`,
        `CC_KIND=container`,
        `CC_LABEL=${ENV_CONTAINER_LABEL}:${opts.envId}`,
        `CC_ALLOWED_ORIGINS=${env.PUBLIC_URL}`,
      ],
      HostConfig: {
        Binds: [
          `${envWorkspaceHostDir(opts.envId)}:/workspace`,
          `${envStateHostDir(opts.envId)}:/var/lib/cc-env`,
          ...devBinds,
          ...sshBinds,
          ...dockerSockBinds,
        ],
        GroupAdd: dockerSockGroups,
        NetworkMode: env.DOCKER_NETWORK,
        ReadonlyRootfs: true,
        Tmpfs: {
          '/tmp': 'rw,nosuid,size=256m',
          '/run': 'rw,nosuid,size=64m',
          '/home/coder': 'rw,nosuid,size=512m,uid=1000,gid=1000',
        },
        ExtraHosts: ['host.docker.internal:host-gateway'],
        Memory: 4 * 1024 * 1024 * 1024,
        NanoCpus: 2 * 1_000_000_000,
        PidsLimit: 512,
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['ALL'],
        AutoRemove: false,
      },
    })
  }

  private async stopContainerSafe(containerId: string, remove: boolean): Promise<void> {
    const c = getDocker().getContainer(containerId)
    try {
      await c.stop({ t: 5 })
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode
      if (code !== 304 && code !== 404) logger.warn({ err }, 'env container stop failed')
    }
    if (remove) {
      try {
        await c.remove({ force: true })
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode
        if (code !== 404) logger.warn({ err }, 'env container remove failed')
      }
    }
  }

  private async removeByLabel(envId: string): Promise<void> {
    const d = getDocker()
    try {
      const list = await d.listContainers({
        all: true,
        filters: { label: [`${ENV_CONTAINER_LABEL}=${envId}`] },
      })
      for (const c of list) {
        try {
          await d.getContainer(c.Id).remove({ force: true })
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode
          if (code !== 404) logger.warn({ err, envId }, 'label remove failed')
        }
      }
    } catch (err) {
      logger.warn({ err, envId }, 'label list failed')
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

/**
 * Resolve an env's stored URL to an absolute origin we can probe from the
 * server side. Relative paths (container envs like `/env/<id>`) are rooted
 * at PUBLIC_URL — that's where the reverse proxy lives.
 */
function absoluteUrlFromEnv(envUrl: string): string {
  if (envUrl.startsWith('http://') || envUrl.startsWith('https://')) return envUrl
  const base = env.PUBLIC_URL.replace(/\/+$/, '')
  return `${base}${envUrl}`
}

async function probeHealthzUnauthed(baseUrl: string): Promise<boolean> {
  try {
    const res = await undiciRequest(`${baseUrl.replace(/\/+$/, '')}/healthz`, {
      method: 'GET',
      headersTimeout: HEALTH_PROBE_TIMEOUT_MS,
      bodyTimeout: HEALTH_PROBE_TIMEOUT_MS,
    })
    await res.body.dump()
    return res.statusCode >= 200 && res.statusCode < 400
  } catch {
    return false
  }
}

export const envManager = new EnvManager()
