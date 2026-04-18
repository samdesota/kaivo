import { spawn } from 'node:child_process'
import { logger } from '../logger.js'
import { getDocker } from '../docker/client.js'
import { env } from '../env.js'
import { sandboxManager } from '../sandbox/manager.js'

export interface PreviewPort {
  port: number
  address: string
  process: string | null
}

interface PortsChangedEvent {
  sandboxId: string
  ports: PreviewPort[]
}

type Listener = (evt: PortsChangedEvent) => void

const POLL_INTERVAL_MS = 3_000
const PORT_KEY = (p: PreviewPort) => `${p.port}|${p.process ?? ''}`
const IP_CACHE_MS = 30_000

interface SandboxState {
  ports: PreviewPort[]
  timer: ReturnType<typeof setInterval> | null
  inflight: boolean
  ip: { value: string | null; fetchedAt: number } | null
}

class PreviewService {
  private state = new Map<string, SandboxState>()
  private listeners = new Map<string, Set<Listener>>()

  constructor() {
    sandboxManager.onEvent((evt) => {
      if (evt.type === 'archived' || evt.type === 'deleted') {
        this.stopPolling(evt.sandboxId)
        // Emit a final empty-ports update for subscribers before dropping.
        this.emit(evt.sandboxId, [])
        this.state.delete(evt.sandboxId)
      }
      if (evt.type === 'created' || evt.type === 'status_changed') {
        // If active and has subscribers, kick off polling again.
        if (this.listeners.get(evt.sandboxId)?.size) {
          void this.ensurePolling(evt.sandboxId)
        }
      }
    })
  }

  /** Cached last-known port set. */
  getPorts(sandboxId: string): PreviewPort[] {
    return this.state.get(sandboxId)?.ports ?? []
  }

  subscribe(sandboxId: string, fn: Listener): () => void {
    let set = this.listeners.get(sandboxId)
    if (!set) {
      set = new Set()
      this.listeners.set(sandboxId, set)
    }
    set.add(fn)
    void this.ensurePolling(sandboxId)
    return () => {
      set!.delete(fn)
      if (set!.size === 0) {
        this.listeners.delete(sandboxId)
        this.stopPolling(sandboxId)
      }
    }
  }

  private async ensurePolling(sandboxId: string): Promise<void> {
    let st = this.state.get(sandboxId)
    if (!st) {
      st = { ports: [], timer: null, inflight: false, ip: null }
      this.state.set(sandboxId, st)
    }
    if (st.timer) return
    // Immediate poll, then interval.
    await this.pollOnce(sandboxId)
    st.timer = setInterval(() => {
      this.pollOnce(sandboxId).catch((err) =>
        logger.warn({ err, sandboxId }, 'preview poll failed'),
      )
    }, POLL_INTERVAL_MS)
    st.timer.unref()
  }

  private stopPolling(sandboxId: string): void {
    const st = this.state.get(sandboxId)
    if (!st) return
    if (st.timer) {
      clearInterval(st.timer)
      st.timer = null
    }
  }

  private async pollOnce(sandboxId: string): Promise<void> {
    const st = this.state.get(sandboxId)
    if (!st || st.inflight) return
    st.inflight = true
    try {
      const sb = await sandboxManager.get(sandboxId)
      if (!sb || !sb.running || !sb.containerId) {
        if (st.ports.length > 0) {
          st.ports = []
          this.emit(sandboxId, [])
        }
        return
      }
      const raw = await runSsLntp(sb.containerId)
      const parsed = parseSsOutput(raw)
      const before = new Set(st.ports.map(PORT_KEY))
      const after = new Set(parsed.map(PORT_KEY))
      const changed =
        before.size !== after.size ||
        [...after].some((k) => !before.has(k)) ||
        [...before].some((k) => !after.has(k))
      if (changed) {
        st.ports = parsed
        this.emit(sandboxId, parsed)
      }
    } finally {
      st.inflight = false
    }
  }

  private emit(sandboxId: string, ports: PreviewPort[]): void {
    const set = this.listeners.get(sandboxId)
    if (!set) return
    for (const l of set) {
      try {
        l({ sandboxId, ports })
      } catch (err) {
        logger.warn({ err }, 'preview listener threw')
      }
    }
  }

  /** Resolve the container's IP on the shared Docker network; cached briefly. */
  async getContainerIp(sandboxId: string): Promise<string | null> {
    let st = this.state.get(sandboxId)
    if (!st) {
      st = { ports: [], timer: null, inflight: false, ip: null }
      this.state.set(sandboxId, st)
    }
    const now = Date.now()
    if (st.ip && now - st.ip.fetchedAt < IP_CACHE_MS) {
      return st.ip.value
    }
    const sb = await sandboxManager.get(sandboxId)
    if (!sb || !sb.running || !sb.containerId) {
      st.ip = { value: null, fetchedAt: now }
      return null
    }
    try {
      const info = await getDocker().getContainer(sb.containerId).inspect()
      const networks = info.NetworkSettings?.Networks ?? {}
      const preferred = networks[env.DOCKER_NETWORK]
      const ip =
        preferred?.IPAddress ||
        Object.values(networks).find((n) => n?.IPAddress)?.IPAddress ||
        null
      st.ip = { value: ip || null, fetchedAt: now }
      return st.ip.value
    } catch (err) {
      logger.warn({ err, sandboxId }, 'container inspect failed')
      st.ip = { value: null, fetchedAt: now }
      return null
    }
  }
}

/** Run `ss -lntp` inside the sandbox; requires iproute2 in the base image. */
function runSsLntp(containerId: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['exec', containerId, 'ss', '-lntp'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const parts: Buffer[] = []
    child.stdout.on('data', (b) => parts.push(Buffer.from(b)))
    child.stderr.on('data', () => {
      /* drop */
    })
    child.on('exit', () => resolve(Buffer.concat(parts).toString('utf8')))
    child.on('error', () => resolve(''))
  })
}

/**
 * ss -lntp output:
 *   State  Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process
 *   LISTEN 0       128     0.0.0.0:5173        0.0.0.0:*          users:(("python3",pid=42,fd=3))
 *
 * We extract (port, address, process name). Duplicate entries across v4/v6
 * are collapsed by port+process.
 */
export function parseSsOutput(stdout: string): PreviewPort[] {
  const lines = stdout.split(/\r?\n/)
  const seen = new Set<string>()
  const out: PreviewPort[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('LISTEN')) continue
    // Split on whitespace, but preserve the "users:(...)" tail.
    const cols = line.split(/\s+/)
    if (cols.length < 4) continue
    const localCol = cols[3]!
    const lastColon = localCol.lastIndexOf(':')
    if (lastColon < 0) continue
    const addr = localCol.slice(0, lastColon)
    const portStr = localCol.slice(lastColon + 1)
    const port = Number(portStr)
    if (!Number.isFinite(port) || port <= 0) continue

    let process: string | null = null
    const procMatch = line.match(/users:\(\("([^"]+)"/)
    if (procMatch) process = procMatch[1]!

    const key = `${port}|${process ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ port, address: addr, process })
  }
  out.sort((a, b) => a.port - b.port)
  return out
}

export const previewService = new PreviewService()
