import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { FaviconCacheError, faviconService } from '../../favicon/service.js'
import { protectedProcedure, router } from '../trpc.js'

const faviconInputSchema = z.object({
  pageOrigin: z.string().min(1).max(2_000),
  iconUrl: z.string().min(1).max(8_000),
  dataUrl: z.string().min(1).max(200_000),
})

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof FaviconCacheError) return new TRPCError({ code: 'BAD_REQUEST', message: err.message })
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: (err as { message?: string })?.message ?? 'favicon cache error' })
}

export const faviconRouter = router({
  getByOrigins: protectedProcedure
    .input(z.object({ origins: z.array(z.string().min(1).max(2_000)).max(200) }))
    .query(async ({ input }) => faviconService.getByOrigins(input.origins)),

  upsert: protectedProcedure
    .input(faviconInputSchema)
    .mutation(async ({ input }) => {
      try {
        await faviconService.upsert(input)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),
})
