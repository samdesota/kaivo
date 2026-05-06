import net from 'node:net'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import type { AgentBrowserScope, AgentBrowserService } from './agent-browser-service.js'

function socketPath(): string | null {
  if (process.env.CC_DESKTOP_BROWSER_SOCKET) return process.env.CC_DESKTOP_BROWSER_SOCKET
  if (process.env.CC_INSTANCE_ROOT) return path.join(process.env.CC_INSTANCE_ROOT, 'desktop-browser.sock')
  return null
}

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const target = socketPath()
  if (!target) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'browser tools unavailable in this environment' })
  }
  const id = randomUUID()
  return await new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(target)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index === -1) return
      socket.end()
      try {
        const response = JSON.parse(buffer.slice(0, index)) as { id: string; result?: T; error?: { message?: string } }
        if (response.error) reject(toTrpcError(response.error.message ?? 'browser bridge error'))
        else resolve(response.result as T)
      } catch (error) {
        reject(error)
      }
    })
    socket.once('error', () => reject(new TRPCError({ code: 'PRECONDITION_FAILED', message: 'browser tools unavailable in this environment' })))
    socket.setTimeout(10_000, () => {
      socket.destroy()
      reject(new TRPCError({ code: 'TIMEOUT', message: 'browser bridge timed out' }))
    })
  })
}

function withScope(scope: AgentBrowserScope, params: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...params, sandboxId: scope.sandboxId, opencodeSessionId: scope.opencodeSessionId }
}

function toTrpcError(message: string): TRPCError {
  if (message === 'browser tab closed') return new TRPCError({ code: 'PRECONDITION_FAILED', message })
  if (message === 'browser connection not found') return new TRPCError({ code: 'NOT_FOUND', message })
  return new TRPCError({ code: 'BAD_REQUEST', message })
}

export const desktopBrowserSocketService: AgentBrowserService = {
  listTabs: (scope) => call('listTabs', withScope(scope)),
  connectTab: (scope, input) => call('connectTab', withScope(scope, input)),
  openAndConnect: (scope, input) => call('openAndConnect', withScope(scope, input)),
  disconnect: (scope, input) => call('disconnect', withScope(scope, input)),
  snapshot: (scope, input) => call('snapshot', withScope(scope, input)),
  interact: (scope, input) => call('interact', withScope(scope, input as Record<string, unknown>)),
  screenshot: (scope, input) => call('screenshot', withScope(scope, input)),
  executeJs: (scope, input) => call('executeJs', withScope(scope, input)),
  readLogs: (scope, input) => call('readLogs', withScope(scope, input)),
}
