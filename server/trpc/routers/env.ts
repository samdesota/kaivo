import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import { EnvError, envManager } from '../../env-orchestrator/manager.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof EnvError) {
    const code: TRPCError['code'] =
      err.code === 'not_found'
        ? 'NOT_FOUND'
        : err.code === 'invalid_state' ||
            err.code === 'label_required' ||
            err.code === 'url_required'
          ? 'BAD_REQUEST'
          : err.code === 'unreachable'
            ? 'PRECONDITION_FAILED'
            : 'INTERNAL_SERVER_ERROR'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'env error',
  })
}

export const envRouter = router({
  list: protectedProcedure
    .input(z.object({ localIdentityLabel: z.string().min(1).max(200).optional() }).optional())
    .query(async ({ input }) => envManager.list(input ?? {})),

  get: protectedProcedure
    .input(z.object({ id: z.string().min(1), localIdentityLabel: z.string().min(1).max(200).optional() }))
    .query(async ({ input }) => {
      const row = await envManager.get(input.id, input)
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      return row
    }),

  createContainer: protectedProcedure
    .input(z.object({ label: z.string().min(1).max(80) }))
    .mutation(async ({ input }) => {
      try {
        return await envManager.createContainer({ label: input.label })
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  registerLocal: protectedProcedure
    .input(
      z.object({
        url: z
          .string()
          .min(1)
          .max(512)
          .refine((u) => /^https?:\/\//i.test(u), 'url must be absolute'),
        envToken: z.string().min(16).max(512),
        label: z.string().min(1).max(80),
        localIdentityLabel: z.string().min(1).max(200),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await envManager.registerLocal(input)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  unregister: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await envManager.unregister(input.id)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  archive: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await envManager.archive(input.id)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await envManager.delete(input.id)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  restart: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await envManager.restart(input.id)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  health: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await envManager.probeHealth(input.id)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),
})
