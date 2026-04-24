import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import type { Context } from './context.js'
import { resolveEnvAuthToken } from '../envauth/service.js'

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        cause:
          error.cause && typeof error.cause === 'object' && 'code' in error.cause
            ? { code: (error.cause as { code: string }).code, retryAfterSec: (error.cause as { retryAfterSec?: number }).retryAfterSec }
            : undefined,
      },
    }
  },
})

export const router = t.router
export const publicProcedure = t.procedure

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  return next({ ctx: { ...ctx, session: ctx.session } })
})

function extractBearer(headerVal: string | string[] | undefined): string | null {
  const header = Array.isArray(headerVal) ? headerVal[0] : headerVal
  if (!header || typeof header !== 'string') return null
  const lower = header.toLowerCase()
  if (!lower.startsWith('bearer ')) return null
  return header.slice(7).trim() || null
}

/**
 * Auth gate for **env server → identity** calls. The env-server presents the
 * identityToken minted for it (by the orchestrator for container envs, or by
 * install.sh's device flow for local envs).
 */
export const identityProcedure = t.procedure.use(async ({ ctx, next }) => {
  const token = extractBearer(ctx.req.headers['authorization'])
  if (!token) throw new TRPCError({ code: 'UNAUTHORIZED' })
  const envAuth = await resolveEnvAuthToken(token)
  if (!envAuth) throw new TRPCError({ code: 'UNAUTHORIZED' })
  return next({ ctx: { ...ctx, envAuth } })
})
