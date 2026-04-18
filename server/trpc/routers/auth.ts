import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { protectedProcedure, publicProcedure, router } from '../trpc.js'
import {
  AuthError,
  bootstrap,
  isBootstrapped,
  login,
  logout,
} from '../../auth/service.js'
import { clearSessionCookie, setSessionCookie } from '../../auth/cookie.js'

const newPasswordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .max(256)
const loginPasswordSchema = z.string().min(1).max(256)

function authErrorToTrpc(err: unknown): TRPCError {
  if (err instanceof AuthError) {
    if (err.code === 'locked' || err.code === 'backoff') {
      return new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: err.message,
        cause: err,
      })
    }
    return new TRPCError({
      code: err.code === 'already_bootstrapped' ? 'CONFLICT' : 'UNAUTHORIZED',
      message: err.message,
      cause: err,
    })
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'auth error' })
}

export const authRouter = router({
  status: publicProcedure.query(async ({ ctx }) => {
    return {
      firstRun: !(await isBootstrapped()),
      authenticated: ctx.session !== null,
    }
  }),

  bootstrap: publicProcedure
    .input(z.object({ password: newPasswordSchema }))
    .mutation(async ({ input, ctx }) => {
      try {
        const session = await bootstrap(input.password)
        setSessionCookie(ctx.res, session.id, session.expiresAt)
        return { ok: true as const }
      } catch (err) {
        throw authErrorToTrpc(err)
      }
    }),

  login: publicProcedure
    .input(z.object({ password: loginPasswordSchema }))
    .mutation(async ({ input, ctx }) => {
      try {
        const session = await login(input.password, ctx.ip)
        setSessionCookie(ctx.res, session.id, session.expiresAt)
        return { ok: true as const }
      } catch (err) {
        throw authErrorToTrpc(err)
      }
    }),

  logout: protectedProcedure.mutation(async ({ ctx }) => {
    await logout(ctx.session.id)
    clearSessionCookie(ctx.res)
    return { ok: true as const }
  }),
})
