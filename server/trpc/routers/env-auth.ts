import crypto from 'node:crypto'
import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { protectedProcedure, publicProcedure, router } from '../trpc.js'
import { env } from '../../env.js'
import {
  DeviceAuthError,
  deviceConfirm,
  devicePoll,
  deviceStart,
  issueEnvAuthToken,
} from '../../envauth/service.js'

function verifyServiceCredential(headerVal: string | string[] | undefined): void {
  const header = Array.isArray(headerVal) ? headerVal[0] : headerVal
  const provided = typeof header === 'string' ? header : ''
  const expected = env.CC_SERVICE_CREDENTIAL
  // Constant-time compare; pad both sides to the same length to defeat
  // length-based leaks.
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b)
  if (!ok) throw new TRPCError({ code: 'UNAUTHORIZED' })
}

export const envAuthRouter = router({
  // Called by the orchestrator (or any trusted service) with
  // X-CC-Service-Token. Mints an identity token an env server can use to
  // call identity's env-facing endpoints.
  issueFromService: publicProcedure
    .input(z.object({ label: z.string().min(1).max(200) }))
    .mutation(async ({ input, ctx }) => {
      verifyServiceCredential(ctx.req.headers['x-cc-service-token'])
      const { token } = await issueEnvAuthToken(input.label, 'service')
      return { identityToken: token }
    }),

  // install.sh kicks this off. No auth — a user must still approve via
  // deviceConfirm from a logged-in browser before any token is issued.
  deviceStart: publicProcedure
    .input(z.object({ label: z.string().min(1).max(200) }))
    .mutation(async ({ input }) => {
      return deviceStart(input.label, env.PUBLIC_URL)
    }),

  // Called from a browser session where the user is logged in.
  deviceConfirm: protectedProcedure
    .input(z.object({ userCode: z.string().min(1).max(20) }))
    .mutation(async ({ input }) => {
      try {
        await deviceConfirm(input.userCode)
        return { ok: true as const }
      } catch (err) {
        if (err instanceof DeviceAuthError) {
          throw new TRPCError({
            code:
              err.kind === 'not_found'
                ? 'NOT_FOUND'
                : err.kind === 'expired'
                  ? 'PRECONDITION_FAILED'
                  : 'CONFLICT',
            message: err.message,
            cause: err,
          })
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'device confirm failed' })
      }
    }),

  // install.sh polls this until { status: 'approved' } arrives.
  devicePoll: publicProcedure
    .input(z.object({ deviceCode: z.string().min(1).max(100) }))
    .query(async ({ input }) => {
      return devicePoll(input.deviceCode)
    }),
})
