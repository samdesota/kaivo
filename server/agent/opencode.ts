import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { request as undiciRequest } from 'undici'
import { db } from '../db/client.js'
import { repos, sandboxes } from '../db/schema.js'
import { logger } from '../logger.js'
import { getSecret, putSecret } from '../secrets/index.js'
import { sandboxManager } from '../sandbox/manager.js'
import { previewService } from '../preview/service.js'
import { buildProviderEnv } from './providers.js'

export class OpenCodeError extends Error {
  constructor(
    public code:
      | 'sandbox_unavailable'
      | 'no_provider'
      | 'start_failed'
      | 'not_ready'
      | 'not_running',
    message: string,
  ) {
    super(message)
    this.name = 'OpenCodeError'
  }
}

const DEFAULT_PORT = 4096
const READY_TIMEOUT_MS = 5_000
const READY_POLL_MS = 200

function passwordSecretName(sandboxId: string): string {
  return `sandbox.${sandboxId}.opencode_password`
}

async function getOrCreatePassword(sandboxId: string): Promise<string> {
  const existing = await getSecret(passwordSecretName(sandboxId))
  if (existing) return existing
  const fresh = crypto.randomBytes(32).toString('base64url')
  await putSecret(passwordSecretName(sandboxId), fresh)
  return fresh
}

export async function getOpenCodePassword(sandboxId: string): Promise<string | null> {
  return getSecret(passwordSecretName(sandboxId))
}

export interface OpenCodeEndpoint {
  ip: string
  port: number
  password: string
}

/**
 * OpenCode's `serve` enforces HTTP Basic auth with a fixed username of
 * `opencode` when `OPENCODE_SERVER_PASSWORD` is set. Everything we send
 * upstream (proxy requests, ready probes, project register) uses this.
 */
export const OPENCODE_BASIC_USERNAME = 'opencode'

export function opencodeBasicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`${OPENCODE_BASIC_USERNAME}:${password}`).toString('base64')}`
}

/**
 * Start (or restart) `opencode serve` inside a sandbox container. Idempotent:
 * if the server is already responsive on the recorded port, this is a no-op.
 *
 * Steps:
 *   1) Pick port (existing row wins; default 4096) + reuse or mint a password.
 *   2) Write port + password-ref to the `sandboxes` row so the reconciler
 *      and UI know where to reach it.
 *   3) Build the provider-key env from encrypted storage. Loopback base URLs
 *      are rewritten to `host.docker.internal` (sandbox has ExtraHosts).
 *   4) `docker exec -d` the server. Redirect stdout/stderr to a log file
 *      inside the sandbox so crashes can be post-mortem'd via a shell.
 *   5) Readiness-probe `/config` with the bearer header.
 */
export async function startOpenCode(sandboxId: string): Promise<OpenCodeEndpoint> {
  const sb = await sandboxManager.get(sandboxId)
  if (!sb) throw new OpenCodeError('sandbox_unavailable', 'sandbox not found')
  if (!sb.running || !sb.containerId) {
    throw new OpenCodeError('sandbox_unavailable', 'sandbox is not running')
  }

  const row = await db.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1)
  const port = row[0]?.opencodePort ?? DEFAULT_PORT
  const password = await getOrCreatePassword(sandboxId)

  await db
    .update(sandboxes)
    .set({
      opencodePort: port,
      opencodePasswordSecret: passwordSecretName(sandboxId),
    })
    .where(eq(sandboxes.id, sandboxId))

  const ip = await previewService.getContainerIp(sandboxId)
  if (!ip) throw new OpenCodeError('sandbox_unavailable', 'container ip unavailable')

  if (await probeReady(ip, port, password)) {
    logger.info({ sandboxId, port }, 'opencode already running')
    return { ip, port, password }
  }

  const providerEnv = await buildProviderEnv()
  if (Object.keys(providerEnv).length === 0) {
    logger.warn({ sandboxId }, 'starting opencode without any provider keys configured')
  }
  const env: Record<string, string> = {
    ...providerEnv,
    // OpenCode's server enforces this as a bearer check; log line reads
    // "OPENCODE_SERVER_PASSWORD is not set; server is unsecured" when absent.
    OPENCODE_SERVER_PASSWORD: password,
    HOME: '/home/coder',
  }

  // Kill any stale process (readiness-probed false but still running).
  await runExec(sb.containerId, ['pkill', '-f', 'opencode serve'], {}, { detach: false }).catch(
    () => {},
  )

  // The OpenCode web UI's folder picker defaults to $HOME, but inside our
  // sandbox $HOME is /home/coder (tmpfs) which only contains dotfiles —
  // the picker filters those out and shows "No folders". Symlink the
  // workspace into the user's home so it's discoverable from the picker.
  // The tmpfs home is wiped on container restart, so recreate every time.
  await runExec(
    sb.containerId,
    ['bash', '-lc', 'ln -sfn /workspace /home/coder/workspace'],
    {},
    { detach: false },
  ).catch(() => {})

  const cmd = [
    'bash',
    '-lc',
    // Log to /tmp; /workspace is user-owned and keeps logs out of git repos.
    `opencode serve --port ${port} --hostname 0.0.0.0 >/tmp/opencode.log 2>&1 &`,
  ]
  await runExec(sb.containerId, cmd, env)

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await probeReady(ip, port, password)) {
      logger.info({ sandboxId, port }, 'opencode ready')
      // Pre-register any repos that already exist in this sandbox so the
      // folder picker in the web UI lists them. OpenCode only registers
      // projects lazily — hitting `/project/current?directory=...` once
      // persists a project entry for that path.
      await registerExistingRepos(sandboxId, { ip, port, password })
      return { ip, port, password }
    }
    await sleep(READY_POLL_MS)
  }
  throw new OpenCodeError('not_ready', 'opencode did not become ready in 5s')
}

/**
 * Ask OpenCode to register a directory as a project. OpenCode's `/project`
 * list is what the web UI shows in its folder picker; the `current`
 * endpoint creates the entry as a side effect. Idempotent.
 */
export async function registerProject(
  sandboxId: string,
  directory: string,
): Promise<void> {
  const ep = await resolveEndpoint(sandboxId)
  if (!ep) return
  if (!(await isOpenCodeReady(sandboxId))) return
  try {
    const res = await undiciRequest(
      `http://${ep.ip}:${ep.port}/project/current?directory=${encodeURIComponent(directory)}`,
      {
        method: 'GET',
        headers: { authorization: opencodeBasicAuthHeader(ep.password) },
        headersTimeout: 2_000,
        bodyTimeout: 2_000,
      },
    )
    await res.body.dump()
    if (res.statusCode >= 400) {
      logger.warn({ sandboxId, directory, status: res.statusCode }, 'opencode project register failed')
    }
  } catch (err) {
    logger.warn({ err, sandboxId, directory }, 'opencode project register threw')
  }
}

async function registerExistingRepos(
  sandboxId: string,
  ep: OpenCodeEndpoint,
): Promise<void> {
  const rows = await db.select().from(repos).where(eq(repos.sandboxId, sandboxId))
  for (const r of rows) {
    try {
      const res = await undiciRequest(
        `http://${ep.ip}:${ep.port}/project/current?directory=${encodeURIComponent(r.workspacePath)}`,
        {
          method: 'GET',
          headers: { authorization: opencodeBasicAuthHeader(ep.password) },
          headersTimeout: 2_000,
          bodyTimeout: 2_000,
        },
      )
      await res.body.dump()
    } catch (err) {
      logger.warn({ err, sandboxId, path: r.workspacePath }, 'opencode repo register threw')
    }
  }
}

/**
 * Live endpoint for a sandbox's OpenCode server, or null if it's not
 * currently reachable. Does not try to start it.
 */
export async function resolveEndpoint(sandboxId: string): Promise<OpenCodeEndpoint | null> {
  const sb = await sandboxManager.get(sandboxId)
  if (!sb || !sb.running || !sb.containerId) return null
  const row = await db.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1)
  const port = row[0]?.opencodePort ?? DEFAULT_PORT
  const password = await getOrCreatePassword(sandboxId)
  const ip = await previewService.getContainerIp(sandboxId)
  if (!ip) return null
  return { ip, port, password }
}

export async function isOpenCodeReady(sandboxId: string): Promise<boolean> {
  const ep = await resolveEndpoint(sandboxId)
  if (!ep) return false
  return probeReady(ep.ip, ep.port, ep.password)
}

async function probeReady(ip: string, port: number, password: string): Promise<boolean> {
  try {
    const res = await undiciRequest(`http://${ip}:${port}/config`, {
      method: 'GET',
      headers: { authorization: opencodeBasicAuthHeader(password) },
      headersTimeout: 1_500,
      bodyTimeout: 1_500,
    })
    // Any 2xx means it's alive and auth works. 401 means alive but our
    // creds don't match — treat as not-ready so we retry with fresh env.
    await res.body.dump()
    return res.statusCode >= 200 && res.statusCode < 400
  } catch {
    return false
  }
}

function runExec(
  containerId: string,
  cmd: string[],
  env: Record<string, string>,
  opts: { detach?: boolean } = { detach: true },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args: string[] = ['exec']
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`)
    // Default detach so backgrounded opencode outlives the exec invocation.
    // Pass detach:false for one-off setup steps where we need the command
    // to finish before we move on (e.g. symlinks, pkill).
    if (opts.detach !== false) args.push('-d')
    args.push(containerId, ...cmd)
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const errBufs: Buffer[] = []
    child.stderr.on('data', (b) => errBufs.push(Buffer.from(b)))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`docker exec exited ${code}: ${Buffer.concat(errBufs).toString('utf8').slice(0, 500)}`))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
