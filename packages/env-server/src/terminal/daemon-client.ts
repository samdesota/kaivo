import http from 'node:http'
import net from 'node:net'
import WebSocket from 'ws'
import { config } from '../config.js'
import { ShellError, type ShellInfo } from './service.js'

type SnapshotResult = { b64: string; exitCode: number | null; alive: boolean }

export const terminalDaemonSocket = config.CC_TERMINAL_SOCKET ?? null

export function useTerminalDaemon(): boolean {
  return Boolean(terminalDaemonSocket)
}

export const terminalDaemonClient = {
  list(input: { workspaceId?: string } = {}): Promise<ShellInfo[]> {
    const query = input.workspaceId ? `?workspaceId=${encodeURIComponent(input.workspaceId)}` : ''
    return request<ShellInfo[]>('GET', `/shells${query}`)
  },

  create(input: {
    workspaceId?: string | null
    cols?: number
    rows?: number
    cwd?: string
    ownerKind?: 'human' | 'agent'
    ownerSessionId?: string | null
    ownerAgentSessionId?: string | null
  }): Promise<ShellInfo> {
    return request<ShellInfo>('POST', '/shells/create', input)
  },

  get(id: string): Promise<ShellInfo | null> {
    return request<ShellInfo>('GET', `/shells/${encodeURIComponent(id)}`).catch((err) => {
      if (err instanceof ShellError && err.code === 'not_found') return null
      throw err
    })
  },

  resize(id: string, cols: number, rows: number): Promise<ShellInfo> {
    return request<ShellInfo>('POST', '/shells/resize', { id, cols, rows })
  },

  dispose(id: string): Promise<{ ok: true }> {
    return request<{ ok: true }>('POST', '/shells/dispose', { id })
  },

  write(id: string, data: string): Promise<{ ok: true }> {
    return request<{ ok: true }>('POST', '/shells/write', { id, b64: Buffer.from(data, 'utf8').toString('base64') })
  },

  snapshot(id: string): Promise<SnapshotResult> {
    return request<SnapshotResult>('GET', `/shells/${encodeURIComponent(id)}/snapshot`)
  },

  attachWebSocket(id: string): WebSocket {
    if (!terminalDaemonSocket) throw new ShellError('not_found', 'terminal daemon is not configured')
    return new WebSocket(`ws://terminal-daemon/ws/shell/${encodeURIComponent(id)}`, {
      createConnection: () => net.connect(terminalDaemonSocket),
    })
  },
}

async function request<T>(method: string, requestPath: string, body?: unknown): Promise<T> {
  if (!terminalDaemonSocket) throw new ShellError('not_found', 'terminal daemon is not configured')
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  return await new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: terminalDaemonSocket,
        path: requestPath,
        method,
        headers: payload
          ? {
              'content-type': 'application/json',
              'content-length': String(payload.length),
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8')
            const parsed = text ? JSON.parse(text) as T & { error?: string; code?: ShellError['code'] } : undefined
            if (res.statusCode && res.statusCode >= 400) {
              reject(new ShellError(parsed?.code ?? 'not_found', parsed?.error ?? `terminal daemon returned ${res.statusCode}`))
              return
            }
            resolve(parsed as T)
          } catch (err) {
            reject(err)
          }
        })
      },
    )
    req.on('error', (err) => reject(new ShellError('not_found', `terminal daemon unavailable: ${err.message}`)))
    if (payload) req.write(payload)
    req.end()
  })
}
