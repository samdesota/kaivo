import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import { RepoError, repoService } from '../../repo/service.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof RepoError) {
    const code: TRPCError['code'] =
      err.code === 'not_found'
        ? 'NOT_FOUND'
        : err.code === 'sandbox_unavailable'
          ? 'PRECONDITION_FAILED'
          : err.code === 'invalid_url' ||
              err.code === 'slug_conflict' ||
              err.code === 'github_not_connected'
            ? 'BAD_REQUEST'
            : 'INTERNAL_SERVER_ERROR'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'repo error',
  })
}

const addInput = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('url'),
    sandboxId: z.string().min(1),
    url: z.string().min(1).max(2048),
    ref: z.string().max(256).optional(),
  }),
  z.object({
    source: z.literal('github'),
    sandboxId: z.string().min(1),
    repoFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/name'),
    ref: z.string().max(256).optional(),
  }),
])

export const repoRouter = router({
  list: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1) }))
    .query(async ({ input }) => repoService.list(input.sandboxId)),

  add: protectedProcedure.input(addInput).mutation(async ({ input }) => {
    try {
      if (input.source === 'url') {
        return await repoService.add({
          sandboxId: input.sandboxId,
          source: 'url',
          url: input.url,
          ref: input.ref,
        })
      }
      return await repoService.add({
        sandboxId: input.sandboxId,
        source: 'github',
        repoFullName: input.repoFullName,
        ref: input.ref,
      })
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  remove: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1), repoId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await repoService.remove(input.sandboxId, input.repoId)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),
})
