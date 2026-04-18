import fastifyWebsocket from '@fastify/websocket'
import { terminalService } from '../terminal/service.js'
import { resolveSession } from '../auth/service.js'
import { SESSION_COOKIE } from '../auth/cookie.js'
import { logger } from '../logger.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerShellWsRoutes(server: any): Promise<void> {
  if (!server.hasPlugin('@fastify/websocket')) {
    await server.register(fastifyWebsocket, {
      options: { maxPayload: 2 * 1024 * 1024 },
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.register(async (scoped: any) => {
    scoped.get(
      '/ws/shell/:id',
      { websocket: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (socket: any, req: any) => {
        const authed = await isAuthedRequest(req.headers.cookie)
        if (!authed) {
          socket.close(4401, 'unauthorized')
          return
        }

        const id = req.params.id as string
        const attached = terminalService.attach(id, (chunk) => {
          try {
            socket.send(chunk)
          } catch (err) {
            logger.warn({ err, id }, 'shell ws send failed')
          }
        })
        if (!attached) {
          socket.close(4404, 'shell not found')
          return
        }

        try {
          socket.send(attached.snapshot)
        } catch (err) {
          logger.warn({ err, id }, 'shell ws send snapshot failed')
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        socket.on('message', (data: any, isBinary: boolean) => {
          const str = isBinary
            ? (data as Buffer).toString('utf8')
            : typeof data === 'string'
              ? data
              : Buffer.isBuffer(data)
                ? data.toString('utf8')
                : String(data)
          if (str.startsWith('{')) {
            try {
              const msg = JSON.parse(str)
              if (msg && msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
                void terminalService.resize(id, msg.cols, msg.rows)
                return
              }
              if (msg && typeof msg.data === 'string') {
                terminalService.sendKeys(id, msg.data)
                return
              }
            } catch {
              // fall through — treat as raw input
            }
          }
          terminalService.sendKeys(id, str)
        })

        socket.on('close', () => {
          attached.unsubscribe()
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        socket.on('error', (err: any) => {
          logger.warn({ err, id }, 'shell ws errored')
          attached.unsubscribe()
        })
      },
    )
  })
}

async function isAuthedRequest(cookieHeader: string | undefined): Promise<boolean> {
  if (!cookieHeader) return false
  const sid = parseCookie(cookieHeader, SESSION_COOKIE)
  if (!sid) return false
  const session = await resolveSession(sid)
  return session !== null
}

function parseCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return null
}
