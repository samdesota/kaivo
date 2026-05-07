import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyReply } from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import { z } from 'zod'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { ShellError, terminalService } from './service.js'

const createSchema = z.object({
  workspaceId: z.string().nullable().optional(),
  cols: z.number().int().positive().max(500).optional(),
  rows: z.number().int().positive().max(500).optional(),
  cwd: z.string().optional(),
  ownerKind: z.enum(['human', 'agent']).optional(),
  ownerSessionId: z.string().nullable().optional(),
  ownerAgentSessionId: z.string().nullable().optional(),
})

const resizeSchema = z.object({
  id: z.string().min(1),
  cols: z.number().int().positive().max(500),
  rows: z.number().int().positive().max(500),
})
const idSchema = z.object({ id: z.string().min(1) })
const writeSchema = z.object({ id: z.string().min(1), b64: z.string() })

export async function buildTerminalDaemon() {
  const app = Fastify({ logger: false })
  await app.register(fastifyWebsocket)

  app.get('/healthz', async () => ({
    ok: true,
    instanceId: config.CC_INSTANCE_ID,
    pid: process.pid,
  }))

  app.get('/shells', async (req) => {
    const query = req.query as { workspaceId?: string }
    return terminalService.list(query.workspaceId ? { workspaceId: query.workspaceId } : {})
  })

  app.get('/shells/:id', async (req, reply) => {
    const info = terminalService.get((req.params as { id: string }).id)
    if (!info) return reply.code(404).send({ error: 'shell not found', code: 'not_found' })
    return info
  })

  app.post('/shells/create', async (req, reply) => {
    try {
      return await terminalService.create(createSchema.parse(req.body))
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.post('/shells/resize', async (req, reply) => {
    try {
      const input = resizeSchema.parse(req.body)
      return terminalService.resize(input.id, input.cols, input.rows)
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.post('/shells/dispose', async (req, reply) => {
    try {
      terminalService.dispose(idSchema.parse(req.body).id)
      return { ok: true as const }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.post('/shells/write', async (req, reply) => {
    try {
      const input = writeSchema.parse(req.body)
      terminalService.sendKeys(input.id, Buffer.from(input.b64, 'base64').toString('utf8'))
      return { ok: true as const }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.get('/shells/:id/snapshot', async (req, reply) => {
    const id = (req.params as { id: string }).id
    const snap = terminalService.snapshot(id)
    if (snap === null) return reply.code(404).send({ error: 'shell no longer retained', code: 'not_found' })
    const info = terminalService.get(id)
    return {
      b64: Buffer.from(snap, 'utf8').toString('base64'),
      exitCode: info?.exitCode ?? null,
      alive: info?.alive ?? false,
    }
  })

  app.get('/ws/shell/:id', { websocket: true } as never, async (socket, req) => {
    const id = (req.params as { id: string }).id
    let attached: { snapshot: string; detach: () => void } | null = null
    try {
      attached = terminalService.attach(id, (chunk) => {
        try {
          socket.send(chunk)
        } catch (err) {
          logger.warn({ err, id }, 'terminal daemon ws send failed')
        }
      })
    } catch {
      socket.close(4404, 'shell not found')
      return
    }

    try {
      socket.send(attached.snapshot)
    } catch {
      // ignore
    }

    socket.on('message', (data) => {
      try {
        terminalService.write(id, data.toString('utf8'))
      } catch (err) {
        logger.warn({ err, id }, 'terminal daemon ws write failed')
      }
    })
    socket.on('close', () => attached?.detach())
  })

  return app
}

export async function listenTerminalDaemon(socketPath: string): Promise<void> {
  try {
    fs.unlinkSync(socketPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  const app = await buildTerminalDaemon()
  await app.listen({ path: socketPath })
  fs.chmodSync(socketPath, 0o600)
  logger.info({ socketPath }, 'terminal daemon listening')

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'terminal daemon shutting down')
    terminalService.shutdownAll()
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof ShellError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'timeout' ? 408 : 400
    return reply.code(status).send({ error: err.message, code: err.code })
  }
  return reply.code(500).send({ error: (err as { message?: string })?.message ?? 'terminal daemon error' })
}
