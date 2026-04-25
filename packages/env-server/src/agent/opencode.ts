import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'
import type { Readable } from 'node:stream'
import { request as undiciRequest } from 'undici'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { getMeta, setOpencodePort } from '../envmeta/service.js'
import {
  IdentityAuthError,
  IdentityUnreachableError,
  getIdentityToken,
  resolveProviderKeys,
} from '../identity/client.js'

export class OpenCodeError extends Error {
  constructor(
    public code:
      | 'no_provider'
      | 'identity_unavailable'
      | 'identity_unauthorized'
      | 'start_failed'
      | 'not_ready'
      | 'not_running',
    message: string,
  ) {
    super(message)
    this.name = 'OpenCodeError'
  }
}

export interface OpenCodeEndpoint {
  host: string
  port: number
  password: string
}

export const OPENCODE_BASIC_USERNAME = 'opencode'

export function opencodeBasicAuthHeader(password: string): string {
  return `Basic ${Buffer.from(`${OPENCODE_BASIC_USERNAME}:${password}`).toString('base64')}`
}

const READY_TIMEOUT_MS = 45_000
const READY_POLL_MS = 200

/**
 * Rewrite a base URL's loopback host depending on where this env-server
 * runs. When CC_KIND=container, opencode shares the sandbox's loopback
 * with the env-server, and external loopback URLs must go via the
 * docker-gateway alias the orchestrator provisioned. When CC_KIND=local,
 * opencode can reach the host's loopback directly.
 */
function rewriteProviderUrl(url: string): string {
  try {
    const u = new URL(url)
    const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0'])
    if (config.CC_KIND === 'container' && LOOPBACK.has(u.hostname)) {
      u.hostname = 'host.docker.internal'
      return u.toString()
    }
    if (config.CC_KIND === 'local' && u.hostname === 'host.docker.internal') {
      u.hostname = 'localhost'
      return u.toString()
    }
    return url
  } catch {
    return url
  }
}

async function pickEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (typeof addr === 'object' && addr && typeof addr.port === 'number') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close()
        reject(new Error('no address on ephemeral listener'))
      }
    })
  })
}

async function probeReady(host: string, port: number, password: string): Promise<boolean> {
  try {
    const res = await undiciRequest(`http://${host}:${port}/config`, {
      method: 'GET',
      headers: { authorization: opencodeBasicAuthHeader(password) },
      // /config blocks until the plugin loads; allow the full ready window
      // for a single probe.
      headersTimeout: READY_TIMEOUT_MS,
      bodyTimeout: READY_TIMEOUT_MS,
    })
    await res.body.dump()
    return res.statusCode >= 200 && res.statusCode < 400
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Strip ANSI color codes so log entries stay greppable.
const ANSI_RE = /\x1b\[[0-9;]*m/g

/**
 * Stream a child stdio pipe through the env-server logger, one structured
 * entry per line. `level` is the pino level used for every line — opencode
 * doesn't tag severity itself, so we lean on which fd it came from
 * (stdout=info, stderr=warn).
 */
function pipeToLogger(stream: Readable, level: 'info' | 'warn'): void {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  rl.on('line', (raw) => {
    const line = raw.replace(ANSI_RE, '').trimEnd()
    if (!line) return
    logger[level]({ svc: 'opencode' }, line)
  })
  rl.on('error', () => {
    // child closed; nothing to do
  })
}

/**
 * Send `signal` to the process group led by `pid`. We spawn opencode with
 * `detached: true` so its pid is also its pgid; signalling `-pid` reaches
 * both the npm Node wrapper and the bun child it spawnSyncs (a plain
 * `kill(pid)` only hits the wrapper, leaving the bun child holding the
 * listen port).
 */
function killTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    // group already gone — fall through to a direct kill in case the
    // child somehow isn't a group leader after all.
    try {
      process.kill(pid, signal)
    } catch {
      // truly gone
    }
  }
}

/**
 * Poll until nothing is bound to host:port, or the deadline passes. Used
 * after killing opencode so the next spawn doesn't hit EADDRINUSE while
 * the OS is still tearing down the listener.
 */
async function waitPortFree(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer()
      srv.unref()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => srv.close(() => resolve(true)))
      try {
        srv.listen(port, host)
      } catch {
        resolve(false)
      }
    })
    if (free) return
    await sleep(100)
  }
}

interface OpenCodeState {
  child: ChildProcess | null
  port: number | null
  password: string | null
  ready: boolean
  agentShellToken: string | null
  agentShellTokenHash: string | null
  bootstrapInFlight: Promise<OpenCodeEndpoint> | null
}

class OpenCodeSupervisor {
  private state: OpenCodeState = {
    child: null,
    port: null,
    password: null,
    ready: false,
    agentShellToken: null,
    agentShellTokenHash: null,
    bootstrapInFlight: null,
  }

  /** Fresh bearer the opencode plugin will present on /trpc/agentShell.* */
  mintAgentShellToken(): string {
    const tok = crypto.randomBytes(32).toString('hex')
    const hash = crypto.createHash('sha256').update(tok).digest('hex')
    this.state.agentShellToken = tok
    this.state.agentShellTokenHash = hash
    return tok
  }

  verifyAgentShellToken(token: string): boolean {
    if (!this.state.agentShellTokenHash) return false
    const incoming = crypto.createHash('sha256').update(token).digest('hex')
    const a = Buffer.from(incoming)
    const b = Buffer.from(this.state.agentShellTokenHash)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  isReady(): boolean {
    return this.state.ready
  }

  currentEndpoint(): OpenCodeEndpoint | null {
    if (!this.state.port || !this.state.password) return null
    return {
      host: '127.0.0.1',
      port: this.state.port,
      password: this.state.password,
    }
  }

  /**
   * Start (or no-op if already running) `opencode serve`. Idempotent. If a
   * start is already in flight, waits for that one to finish and returns
   * its result rather than racing a second spawn.
   */
  async start(): Promise<OpenCodeEndpoint> {
    if (this.state.bootstrapInFlight) return this.state.bootstrapInFlight
    const p = this.startInner()
    this.state.bootstrapInFlight = p
    try {
      return await p
    } finally {
      this.state.bootstrapInFlight = null
    }
  }

  private async startInner(): Promise<OpenCodeEndpoint> {
    // Pull provider keys from identity. No provider → skip (UI will prompt
    // the user to configure one, then call agent.restart()).
    let providerEnv: Record<string, string> = {}
    try {
      providerEnv = await resolveProviderKeys()
    } catch (err) {
      if (err instanceof IdentityAuthError) {
        throw new OpenCodeError('identity_unauthorized', err.message)
      }
      if (err instanceof IdentityUnreachableError) {
        throw new OpenCodeError('identity_unavailable', err.message)
      }
      throw err
    }
    if (!providerEnv.ANTHROPIC_API_KEY && !providerEnv.OPENAI_API_KEY) {
      throw new OpenCodeError(
        'no_provider',
        'no provider API key configured in identity service',
      )
    }
    // Rewrite loopback URLs based on this env's kind. Identity returns raw
    // URLs; we adapt them to the container/local boundary.
    for (const key of ['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL']) {
      const val = providerEnv[key]
      if (val) providerEnv[key] = rewriteProviderUrl(val)
    }

    // Persisted port: survives restart so opencode's project DB path stays
    // stable. Ephemeral on first boot.
    const meta = getMeta()
    let port = meta.opencodePort
    if (!port) {
      port = await pickEphemeralPort()
      setOpencodePort(port)
    }

    // Password: fresh per process. Stored in memory only — not persisted.
    // The proxy layer reads this to inject auth on forwarded requests.
    const password = crypto.randomBytes(32).toString('base64url')

    // If there's an existing child, kill it (restart path).
    this.stopInner()

    const token = this.mintAgentShellToken()
    await this.ensureOpencodeConfig()
    await this.ensureXdgDirs()

    const spawnEnv: Record<string, string> = {
      ...process.env,
      ...providerEnv,
      OPENCODE_SERVER_PASSWORD: password,
      CLOUDCODE_AGENT_TOKEN: token,
      // Plugin talks to this env-server on loopback (we publish /trpc
      // there; the plugin just treats it as "the cloud-code app").
      CLOUDCODE_APP_URL: `http://127.0.0.1:${config.CC_PORT}`,
      XDG_CONFIG_HOME: path.join(config.CC_STATE_DIR, 'xdg', 'config'),
      XDG_DATA_HOME: path.join(config.CC_STATE_DIR, 'xdg', 'data'),
      XDG_STATE_HOME: path.join(config.CC_STATE_DIR, 'xdg', 'state'),
      XDG_CACHE_HOME: path.join(config.CC_STATE_DIR, 'xdg', 'cache'),
    }

    // `detached: true` puts opencode in its own process group. The npm
    // `opencode` bin is a Node wrapper that spawnSyncs the real bun
    // binary; killing only the wrapper PID leaves the bun child holding
    // the listen port. Owning the group lets us signal the whole tree
    // via `process.kill(-pid, …)` on stop.
    //
    // Pipe stdout/stderr so we can fan them through the env-server logger
    // (one structured entry per line, tagged service=opencode).
    const child = spawn(
      config.CC_OPENCODE_BIN,
      ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
      {
        cwd: config.CC_WORKING_DIR,
        env: spawnEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    )
    child.unref()
    if (child.stdout) pipeToLogger(child.stdout, 'info')
    if (child.stderr) pipeToLogger(child.stderr, 'warn')

    child.on('exit', (code, signal) => {
      logger.info({ code, signal }, 'opencode exited')
      if (this.state.child === child) {
        this.state.child = null
        this.state.ready = false
        this.state.password = null
      }
    })
    child.on('error', (err) => {
      logger.warn({ err }, 'opencode spawn error')
    })

    this.state.child = child
    this.state.port = port
    this.state.password = password
    this.state.ready = false

    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (!this.state.child) {
        // Child died before ready — bail out.
        throw new OpenCodeError('start_failed', 'opencode exited before ready')
      }
      if (await probeReady('127.0.0.1', port, password)) {
        this.state.ready = true
        logger.info({ port }, 'opencode ready')
        // Best-effort: tell opencode about the workspace so the folder
        // picker lists it.
        await this.registerProject(config.CC_WORKING_DIR).catch(() => undefined)
        return { host: '127.0.0.1', port, password }
      }
      await sleep(READY_POLL_MS)
    }
    throw new OpenCodeError(
      'not_ready',
      `opencode did not become ready in ${Math.round(READY_TIMEOUT_MS / 1000)}s`,
    )
  }

  /** Kill any running child. Safe to call when nothing is running. */
  stop(): void {
    this.stopInner()
  }

  /**
   * Kill any running child AND wait for the OS to release the listening
   * port. Used before a restart so the new spawn doesn't race the old
   * process's port and crash with EADDRINUSE.
   */
  async stopAndWait(): Promise<void> {
    const c = this.state.child
    const port = this.state.port
    this.stopInner()
    if (!c) return
    if (c.exitCode === null && c.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          killTree(c.pid, 'SIGKILL')
          resolve()
        }, 5_000)
        c.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    if (port) await waitPortFree('127.0.0.1', port, 5_000)
  }

  private stopInner(): void {
    const c = this.state.child
    if (!c) return
    killTree(c.pid, 'SIGTERM')
    this.state.child = null
    this.state.ready = false
    this.state.password = null
  }

  async registerProject(directory: string): Promise<void> {
    const ep = this.currentEndpoint()
    if (!ep || !this.state.ready) return
    try {
      const res = await undiciRequest(
        `http://${ep.host}:${ep.port}/project/current?directory=${encodeURIComponent(directory)}`,
        {
          method: 'GET',
          headers: { authorization: opencodeBasicAuthHeader(ep.password) },
          headersTimeout: 2_000,
          bodyTimeout: 2_000,
        },
      )
      await res.body.dump()
      if (res.statusCode >= 400) {
        logger.warn({ directory, status: res.statusCode }, 'opencode project register failed')
      }
    } catch (err) {
      logger.warn({ err, directory }, 'opencode project register threw')
    }
  }

  private async ensureOpencodeConfig(): Promise<void> {
    const xdgConfigHome = path.join(config.CC_STATE_DIR, 'xdg', 'config')
    const dir = path.join(xdgConfigHome, 'opencode')
    await fs.mkdir(dir, { recursive: true })
    const cfg = {
      plugin: [config.CC_OPENCODE_PLUGIN_PATH],
      agent: {
        plan: { mode: 'primary', model: 'anthropic/claude-opus-4-7' },
        build: { mode: 'primary', model: 'anthropic/claude-opus-4-6' },
        general: { mode: 'subagent', model: 'anthropic/claude-sonnet-4-6' },
        explore: { mode: 'subagent', model: 'anthropic/claude-sonnet-4-6' },
      },
    }
    await fs.writeFile(path.join(dir, 'opencode.json'), JSON.stringify(cfg, null, 2))
  }

  private async ensureXdgDirs(): Promise<void> {
    for (const sub of ['config', 'data', 'state', 'cache']) {
      await fs.mkdir(path.join(config.CC_STATE_DIR, 'xdg', sub), { recursive: true })
    }
  }
}

export const opencodeSupervisor = new OpenCodeSupervisor()

export async function ensureOpencodeBootstrapped(): Promise<void> {
  // Best-effort: try to start opencode on boot. If no identity token yet
  // (unpaired or install.sh not run), or no provider keys, log and carry
  // on — the UI can call `agent.restart()` to retry.
  if (!getIdentityToken()) {
    logger.info('no identity token; skipping opencode bootstrap')
    return
  }
  try {
    await opencodeSupervisor.start()
  } catch (err) {
    if (err instanceof OpenCodeError) {
      logger.warn({ code: err.code, msg: err.message }, 'opencode bootstrap deferred')
    } else {
      logger.warn({ err }, 'opencode bootstrap failed')
    }
  }
}
