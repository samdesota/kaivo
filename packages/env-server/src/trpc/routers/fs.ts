import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { authedProcedure, router } from '../trpc.js'
import {
  FsError,
  type FsEvent,
  browseHome,
  listDirectory,
  readFile,
  watchFilePath,
  watchWorkspace,
  writeFile,
} from '../../fs/service.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof FsError) {
    const code: TRPCError['code'] =
      err.code === 'not_found'
        ? 'NOT_FOUND'
        : err.code === 'path_traversal'
          ? 'BAD_REQUEST'
          : 'BAD_REQUEST'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'fs error',
  })
}

export const fsRouter = router({
  list: authedProcedure
    .input(z.object({ path: z.string().min(1).max(2048) }))
    .query(async ({ input }) => {
      try {
        return await listDirectory(input.path)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  read: authedProcedure
    .input(
      z.object({
        path: z.string().min(1).max(2048),
        absolute: z.boolean().optional(),
      }),
    )
    .query(async ({ input }) => {
      try {
        return await readFile(input.path, { absolute: input.absolute })
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  write: authedProcedure
    .input(
      z.object({
        path: z.string().min(1).max(2048),
        content: z.string().max(10 * 1024 * 1024),
        absolute: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await writeFile(input.path, input.content, { absolute: input.absolute })
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  watch: authedProcedure
    .input(
      z.object({
        path: z.string().min(1).max(2048),
        absolute: z.boolean().optional(),
      }).optional(),
    )
    .subscription(({ input }) => {
      return observable<FsEvent>((emit) => {
        const unsub = input
          ? watchFilePath(input.path, { absolute: input.absolute }, (evt) => emit.next(evt))
          : watchWorkspace((evt) => emit.next(evt))
        return unsub
      })
    }),

  /**
   * Folder picker source. Lists directories under $HOME so the new-session
   * UI can let the user pick an arbitrary working dir. `path` is optional
   * — omitted means "start at $HOME".
   */
  browseHome: authedProcedure
    .input(z.object({ path: z.string().min(1).max(4096).optional() }))
    .query(async ({ input }) => {
      try {
        return await browseHome(input.path)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),
})
