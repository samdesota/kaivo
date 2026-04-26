import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { authedProcedure, router } from '../trpc.js'
import { ShellError, terminalService } from '../../terminal/service.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof ShellError) {
    const code: TRPCError['code'] =
      err.code === 'not_found' ? 'NOT_FOUND' : 'BAD_REQUEST'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'shell error',
  })
}

export const shellRouter = router({
  list: authedProcedure
    .input(z.object({ workspaceId: z.string().min(1).optional() }).optional())
    .query(({ input }) => terminalService.list(input ?? {})),

  create: authedProcedure
    .input(
      z
        .object({
          workspaceId: z.string().min(1).optional(),
          cols: z.number().int().positive().max(500).optional(),
          rows: z.number().int().positive().max(200).optional(),
          cwd: z.string().max(1024).optional(),
          ownerAgentSessionId: z.string().min(1).optional(),
        })
        .optional(),
    )
    .mutation(async ({ input }) => {
      try {
        return await terminalService.create(input ?? {})
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  resize: authedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        cols: z.number().int().positive().max(500),
        rows: z.number().int().positive().max(200),
      }),
    )
    .mutation(({ input }) => {
      try {
        return terminalService.resize(input.id, input.cols, input.rows)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  dispose: authedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => {
      terminalService.dispose(input.id)
      return { ok: true as const }
    }),
})
