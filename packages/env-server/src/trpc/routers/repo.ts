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

// Phase 3 stub: repos.* endpoints return the SQLite rows but don't yet
// orchestrate clone/remove. Phase 4 will flesh out add/remove once
// identity-side `envApi.listRepoConfigs` is plumbed.
export const repoRouter = router({
  list: authedProcedure.query(() => {
    return db.select().from(repos).all()
  }),

  listRecentFolders: authedProcedure.query(() => recentFolderService.list()),

  upsertRecentFolder: authedProcedure
    .input(z.object({ path: z.string().min(1).max(4096), label: z.string().max(200).nullable().optional() }))
    .mutation(({ input }) => recentFolderService.upsert(input.path, input.label)),

  listConfigs: authedProcedure.query(async () => repoService.listConfigs()),

  cloneConfig: authedProcedure
    .input(z.object({ configId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await repoService.cloneConfig(input.configId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),
})
