import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import { SandboxError, sandboxManager } from '../../sandbox/manager.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof SandboxError) {
    const code: TRPCError['code'] =
      err.code === 'not_found'
        ? 'NOT_FOUND'
        : err.code === 'name_required' || err.code === 'invalid_state'
          ? 'BAD_REQUEST'
          : 'INTERNAL_SERVER_ERROR'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'sandbox error',
  })
}

export const sandboxRouter = router({
  list: protectedProcedure.query(async () => sandboxManager.list()),

  get: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      const sb = await sandboxManager.get(input.id)
      if (!sb) throw new TRPCError({ code: 'NOT_FOUND' })
      return sb
    }),

  create: protectedProcedure
    .input(z.object({ name: z.string().min(1).max(80) }))
    .mutation(async ({ input }) => {
      try {
        return await sandboxManager.create({ name: input.name })
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  archive: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await sandboxManager.archive(input.id)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await sandboxManager.delete(input.id)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  restart: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await sandboxManager.restart(input.id)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),
})
