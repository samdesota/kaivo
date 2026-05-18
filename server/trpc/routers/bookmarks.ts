import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { BookmarkError, bookmarkService } from '../../bookmarks/service.js'
import { protectedProcedure, router } from '../trpc.js'

const bookmarkInputSchema = z.object({
  title: z.string().min(1).max(500),
  url: z.string().min(1).max(4_096),
  faviconDataUrl: z.string().nullable().optional(),
  faviconUrl: z.string().nullable().optional(),
})

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof BookmarkError) {
    return new TRPCError({
      code: err.code === 'not_found' ? 'NOT_FOUND' : 'BAD_REQUEST',
      message: err.message,
      cause: err,
    })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'bookmark error',
  })
}

export const bookmarksRouter = router({
  list: protectedProcedure.query(async () => bookmarkService.list()),

  upsert: protectedProcedure
    .input(bookmarkInputSchema)
    .mutation(async ({ input }) => {
      try {
        return await bookmarkService.upsert(input)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await bookmarkService.delete(input.id)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),
})

export type BookmarksRouter = typeof bookmarksRouter
