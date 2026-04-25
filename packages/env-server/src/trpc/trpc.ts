import crypto from 'node:crypto'
import { initTRPC, TRPCError } from '@trpc/server'
import type { FastifyRequest, FastifyReply } from 'fastify'
import superjson from 'superjson'
import { getMeta, hashEnvToken, isPaired } from '../envmeta/service.js'
import { opencodeSupervisor } from '../agent/opencode.js'

export interface Context {
  req: FastifyRequest
  res: FastifyReply
  envTokenPresent: boolean
  agentShellTokenPresent: boolean
}

export async function createContext({
  req,
  res,
  info,
}: {
  req: FastifyRequest
  res: FastifyReply
  // tRPC's ws adapter passes `info.connectionParams` (set on the client via
  // createWSClient({ connectionParams })). Browsers can't put headers on a
  // WS upgrade, so this is the only way the bearer reaches us for ws ops.
  info?: { connectionParams?: Record<string, string> | null }
}): Promise<Context> {
  const headerVal = req.headers['authorization']
  const header = Array.isArray(headerVal) ? headerVal[0] : headerVal
  const fromHeader =
    typeof header === 'string' && header.toLowerCase().startsWith('bearer ')
      ? header.slice(7).trim()
      : null
  const fromConnectionParams =
    typeof info?.connectionParams?.token === 'string'
      ? info.connectionParams.token.trim()
      : null
  const token = fromHeader || fromConnectionParams

  if (!token) {
    return { req, res, envTokenPresent: false, agentShellTokenPresent: false }
  }

  // Order: check envToken (webapp) first, then agent-shell token (plugin).
  let envTokenPresent = false
  const meta = getMeta()
  if (meta.envTokenHash) {
    const incoming = hashEnvToken(token)
    const a = Buffer.from(incoming)
    const b = Buffer.from(meta.envTokenHash)
    envTokenPresent = a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  let agentShellTokenPresent = false
  if (!envTokenPresent) {
    agentShellTokenPresent = opencodeSupervisor.verifyAgentShellToken(token)
  }

  return { req, res, envTokenPresent, agentShellTokenPresent }
}

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        cause:
          error.cause && typeof error.cause === 'object' && 'code' in error.cause
            ? { code: (error.cause as { code: string }).code }
            : undefined,
      },
    }
  },
})

export const router = t.router
export const publicProcedure = t.procedure

/**
 * Calls that require a paired bearer envToken. Pairing calls use
 * `pairProcedure` instead; they are the *only* things that respond when
 * the env is unpaired.
 */
export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!isPaired()) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'env is not paired',
    })
  }
  if (!ctx.envTokenPresent) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  return next({ ctx })
})

/**
 * Pairing-only procedures. Rejected once the env is paired.
 */
export const pairProcedure = t.procedure.use(({ next }) => {
  if (isPaired()) {
    throw new TRPCError({ code: 'CONFLICT', message: 'env already paired' })
  }
  return next()
})

/**
 * Plugin-only calls: requires the agent-shell bearer token minted by the
 * opencode supervisor. The plugin running inside opencode presents this on
 * every tRPC call. Webapp-issued envTokens are also accepted so a developer
 * running curl from a browser session can poke agentShell if they want.
 */
export const agentShellProcedure = t.procedure.use(({ ctx, next }) => {
  if (!isPaired()) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'env is not paired',
    })
  }
  if (!ctx.envTokenPresent && !ctx.agentShellTokenPresent) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  return next({ ctx })
})
