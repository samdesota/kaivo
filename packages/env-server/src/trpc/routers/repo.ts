import { authedProcedure, router } from '../trpc.js'
import { db } from '../../db/client.js'
import { repos } from '../../db/schema.js'
import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { RepoError, repoService } from '../../repo/service.js'
import { recentFolderService } from '../../recent-folders/service.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof RepoError) {
    const code: TRPCError['code'] = err.code === 'not_found' ? 'NOT_FOUND' : 'BAD_REQUEST'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'repo error',
  })
}

export const repoRouter = router({
  list: authedProcedure.query(() => db.select().from(repos).all()),

  listWorktrees: authedProcedure.query(() => repoService.listWorktrees()),

  listRecentFolders: authedProcedure.query(() => recentFolderService.list()),

  upsertRecentFolder: authedProcedure
    .input(z.object({ path: z.string().min(1).max(4096), label: z.string().max(200).nullable().optional() }))
    .mutation(({ input }) => recentFolderService.upsert(input.path, input.label)),

  listConfigs: authedProcedure.query(async () => repoService.listConfigs()),

  cloneConfig: authedProcedure
    .input(z.object({ configId: z.string().min(1), worktreeName: z.string().min(1).max(120) }))
    .mutation(async ({ input }) => {
      try {
        return await repoService.cloneConfig(input.configId, input.worktreeName)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  deleteWorktree: authedProcedure
    .input(z.object({ repoId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await repoService.deleteWorktree(input.repoId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),
})
