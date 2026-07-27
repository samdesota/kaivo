import { initTRPC, TRPCError } from '@trpc/server'
import type { FastifyRequest, FastifyReply } from 'fastify'
import superjson from 'superjson'
import { hashEnvToken, hasEnvTokenHash, isPaired } from '../envmeta/service.js'
import { config } from '../config.js'
import { opencodeSupervisor } from '../agent/opencode.js'
import type { EnvPrincipal } from '../auth/principal.js'

export interface Context {
  req: FastifyRequest
  res: FastifyReply
  envTokenPresent: boolean
  agentShellTokenPresent: boolean
  principal?: EnvPrincipal | null
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
    return { req, res, envTokenPresent: false, agentShellTokenPresent: false, principal: null }
  }

  // Order: check envToken (webapp) first, then agent-shell token (plugin).
  let envTokenPresent = false
  const incoming = hashEnvToken(token)
  envTokenPresent = hasEnvTokenHash(incoming)

  let agentShellTokenPresent = false
  let principal: EnvPrincipal | null = envTokenPresent ? { kind: 'user' } : null
  if (!envTokenPresent) {
    const { resolveAgentSessionPrincipal } = await import('../auth/session-credentials.js')
    principal = resolveAgentSessionPrincipal(token)
    if (!principal) agentShellTokenPresent = opencodeSupervisor.verifyAgentShellToken(token)
  }

  return { req, res, envTokenPresent, agentShellTokenPresent, principal }
}

export function contextPrincipal(ctx: Context): EnvPrincipal | null {
  // Preserve direct createCaller test contexts and existing user clients.
  return ctx.principal ?? (ctx.envTokenPresent ? { kind: 'user' } : null)
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

/** User or session-bound agent calls. Process-global plugin tokens are unbound. */
export const principalProcedure = t.procedure.use(({ ctx, next }) => {
  if (!isPaired()) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'env is not paired' })
  }
  if (!contextPrincipal(ctx)) throw new TRPCError({ code: 'UNAUTHORIZED' })
  return next({ ctx })
})

/**
 * Pairing-only procedures. Rejected once the env is paired.
 */
export const pairProcedure = t.procedure.use(({ next }) => {
  if (isPaired() && config.CC_KIND !== 'local') {
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
