import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import {
  FsError,
  listDirectory,
  readFile,
  watchSandbox,
  writeFile,
  type FsEvent,
} from '../../fs/service.js'
import { sandboxManager } from '../../sandbox/manager.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof FsError) {
    const code: TRPCError['code'] =
      err.code === 'not_found'
        ? 'NOT_FOUND'
        : err.code === 'path_traversal'
          ? 'BAD_REQUEST'
          : err.code === 'not_readable'
            ? 'BAD_REQUEST'
            : 'INTERNAL_SERVER_ERROR'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'fs error',
  })
}

async function requireSandbox(id: string) {
  const sb = await sandboxManager.get(id)
  if (!sb) throw new TRPCError({ code: 'NOT_FOUND', message: 'sandbox not found' })
  return sb
}

const pathSchema = z.string().min(1).max(4096)

export const fsRouter = router({
  list: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1), path: pathSchema }))
    .query(async ({ input }) => {
      await requireSandbox(input.sandboxId)
      try {
        return await listDirectory(input.sandboxId, input.path)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  read: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1), path: pathSchema }))
    .query(async ({ input }) => {
      await requireSandbox(input.sandboxId)
      try {
        return await readFile(input.sandboxId, input.path)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  write: protectedProcedure
    .input(
      z.object({
        sandboxId: z.string().min(1),
        path: pathSchema,
        content: z.string().max(5 * 1024 * 1024),
      }),
    )
    .mutation(async ({ input }) => {
      await requireSandbox(input.sandboxId)
      try {
        await writeFile(input.sandboxId, input.path, input.content)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  watch: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1) }))
    .subscription(({ input }) => {
      return observable<FsEvent>((emit) => {
        let unsubscribe: (() => void) | null = null
        ;(async () => {
          await requireSandbox(input.sandboxId)
          unsubscribe = watchSandbox(input.sandboxId, (evt) => emit.next(evt))
        })().catch((err) => emit.error(toTrpcError(err)))
        return () => {
          if (unsubscribe) unsubscribe()
        }
      })
    }),
})
