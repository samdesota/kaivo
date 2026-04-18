import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import { ShellError, terminalService } from '../../terminal/service.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof ShellError) {
    const code: TRPCError['code'] =
      err.code === 'not_found'
        ? 'NOT_FOUND'
        : err.code === 'sandbox_unavailable'
          ? 'PRECONDITION_FAILED'
          : err.code === 'timeout'
            ? 'TIMEOUT'
            : err.code === 'too_large'
              ? 'PAYLOAD_TOO_LARGE'
              : 'INTERNAL_SERVER_ERROR'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'shell error',
  })
}

export const shellRouter = router({
  list: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1) }))
    .query(({ input }) => terminalService.listBySandbox(input.sandboxId)),

  create: protectedProcedure
    .input(
      z.object({
        sandboxId: z.string().min(1),
        cols: z.number().int().min(10).max(500).optional(),
        rows: z.number().int().min(2).max(500).optional(),
        cwd: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await terminalService.create(input)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  resize: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        cols: z.number().int().min(10).max(500),
        rows: z.number().int().min(2).max(500),
      }),
    )
    .mutation(async ({ input }) => {
      await terminalService.resize(input.id, input.cols, input.rows)
      return { ok: true as const }
    }),

  dispose: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => {
      terminalService.dispose(input.id)
      return { ok: true as const }
    }),

  runOnce: protectedProcedure
    .input(
      z.object({
        sandboxId: z.string().min(1),
        cmd: z.string().min(1).max(65536),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().positive().max(10 * 60 * 1000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await terminalService.runOnce(input)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),
})
