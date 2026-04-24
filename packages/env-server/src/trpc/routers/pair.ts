import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { pairProcedure, router } from '../trpc.js'
import { PairError, pairConfirm, pairStart } from '../../pair/service.js'

export const pairRouter = router({
  start: pairProcedure.mutation(() => {
    return pairStart()
  }),

  confirm: pairProcedure
    .input(
      z.object({
        sessionId: z.string().min(1).max(200),
        code: z.string().min(1).max(12),
      }),
    )
    .mutation(({ input }) => {
      try {
        return pairConfirm(input.sessionId, input.code)
      } catch (err) {
        if (err instanceof PairError) {
          const code: TRPCError['code'] =
            err.code === 'not_found'
              ? 'NOT_FOUND'
              : err.code === 'expired'
                ? 'PRECONDITION_FAILED'
                : err.code === 'already_paired'
                  ? 'CONFLICT'
                  : 'BAD_REQUEST'
          throw new TRPCError({ code, message: err.message, cause: err })
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' })
      }
    }),
})
