import { spawn } from 'node:child_process'
import os from 'node:os'
import { logger } from '../logger.js'

export interface PreviewPort {
  port: number
  address: string
  process: string | null
}

interface PortsChangedEvent {
  ports: PreviewPort[]
}

type Listener = (evt: PortsChangedEvent) => void

const POLL_INTERVAL_MS = 3_000
const PORT_KEY = (p: PreviewPort) => `${p.port}|${p.process ?? ''}`

class PreviewService {
  private ports: PreviewPort[] = []
  private listeners = new Set<Listener>()
  private timer: ReturnType<typeof setInterval> | null = null
  private inflight = false

  getPorts(): PreviewPort[] {
    return this.ports
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    this.ensurePolling()
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0) this.stopPolling()
    }
  }

  private ensurePolling(): void {
    if (this.timer) return
    void this.pollOnce()
    this.timer = setInterval(() => {
      this.pollOnce().catch((err) => logger.warn({ err }, 'preview poll failed'))
    }, POLL_INTERVAL_MS)
    this.timer.unref()
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.inflight) return
    this.inflight = true
    try {
      const parsed = await detectListeningPorts()
      const before = new Set(this.ports.map(PORT_KEY))
      const after = new Set(parsed.map(PORT_KEY))
      const changed =
        before.size !== after.size ||
        [...after].some((k) => !before.has(k)) ||
        [...before].some((k) => !after.has(k))
      if (changed) {
        this.ports = parsed
        this.emit()
      }
    } finally {
      this.inflight = false
    }
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l({ ports: this.ports })
      } catch (err) {
        logger.warn({ err }, 'preview listener threw')
      }
    }
  }
}

async function detectListeningPorts(): Promise<PreviewPort[]> {
  if (os.platform() === 'darwin') {
    return runLsof()
  }
  return runSsLntp()
}

function runSsLntp(): Promise<PreviewPort[]> {
  return new Promise((resolve) => {
    const child = spawn('ss', ['-lntp'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const parts: Buffer[] = []
    child.stdout.on('data', (b) => parts.push(Buffer.from(b)))
    child.stderr.on('data', () => {
      // ignore
    })
    child.on('exit', () => resolve(parseSsOutput(Buffer.concat(parts).toString('utf8'))))
    child.on('error', () => resolve([]))
  })
}

function runLsof(): Promise<PreviewPort[]> {
  return new Promise((resolve) => {
    const child = spawn('lsof', ['-iTCP', '-sTCP:LISTEN', '-n', '-P'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const parts: Buffer[] = []
    child.stdout.on('data', (b) => parts.push(Buffer.from(b)))
    child.stderr.on('data', () => {
      // ignore
    })
    child.on('exit', () =>
      resolve(parseLsofOutput(Buffer.concat(parts).toString('utf8'))),
    )
    child.on('error', () => resolve([]))
  })
}

export function parseSsOutput(stdout: string): PreviewPort[] {
  const lines = stdout.split(/\r?\n/)
  const seen = new Set<string>()
  const out: PreviewPort[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line.startsWith('LISTEN')) continue
    const cols = line.split(/\s+/)
    if (cols.length < 4) continue
    const localCol = cols[3]!
    const lastColon = localCol.lastIndexOf(':')
    if (lastColon < 0) continue
    const addr = localCol.slice(0, lastColon)
    const portStr = localCol.slice(lastColon + 1)
    const port = Number(portStr)
    if (!Number.isFinite(port) || port <= 0) continue

    let proc: string | null = null
    const procMatch = line.match(/users:\(\("([^"]+)"/)
    if (procMatch) proc = procMatch[1]!

    const key = `${port}|${proc ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ port, address: addr, process: proc })
  }
  out.sort((a, b) => a.port - b.port)
  return out
}

/**
 * lsof -iTCP -sTCP:LISTEN -n -P output:
 *   COMMAND    PID USER   FD   TYPE            DEVICE SIZE/OFF NODE NAME
 *   node     12345 sam    17u  IPv4 0x00...          0t0  TCP *:5173 (LISTEN)
 *   node     12345 sam    18u  IPv6 0x00...          0t0  TCP [::1]:5173 (LISTEN)
 */
export function parseLsofOutput(stdout: string): PreviewPort[] {
  const lines = stdout.split(/\r?\n/)
  const seen = new Set<string>()
  const out: PreviewPort[] = []
  for (let i = 1; i < lines.length; i++) {
    // Skip header.
    const line = lines[i]!.trim()
    if (!line) continue
    const cols = line.split(/\s+/)
    if (cols.length < 9) continue
    const command = cols[0] ?? null
    const name = cols.slice(8).join(' ')
    // Name looks like "*:5173" or "[::1]:5173" or "127.0.0.1:5173 (LISTEN)"
    const withoutTag = name.replace(/\s*\(LISTEN\)\s*$/, '')
    const lastColon = withoutTag.lastIndexOf(':')
    if (lastColon < 0) continue
    const addr = withoutTag.slice(0, lastColon)
    const portStr = withoutTag.slice(lastColon + 1)
    const port = Number(portStr)
    if (!Number.isFinite(port) || port <= 0) continue
    const key = `${port}|${command ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ port, address: addr, process: command })
  }
  out.sort((a, b) => a.port - b.port)
  return out
}

export const previewService = new PreviewService()
