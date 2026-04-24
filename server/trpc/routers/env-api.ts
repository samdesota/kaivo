import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { identityProcedure, router } from '../trpc.js'
import { buildProviderEnvRaw } from '../../agent/providers.js'
import { RepoConfigError, repoConfigService } from '../../repo/configs.js'

/**
 * Env-facing surface on identity. Authenticated with a bearer identityToken
 * (see `identityProcedure`). Env servers call these to bootstrap opencode
 * and apply repo configs.
 */
export const envApiRouter = router({
  resolveProviderKeys: identityProcedure.query(async () => {
    return buildProviderEnvRaw()
  }),

  listRepoConfigs: identityProcedure.query(async () => {
    return repoConfigService.list()
  }),

  getRepoConfig: identityProcedure
    .input(z.object({ configId: z.string().min(1) }))
    .query(async ({ input }) => {
      const summary = await repoConfigService.get(input.configId)
      if (!summary) throw new TRPCError({ code: 'NOT_FOUND' })
      try {
        const files = await repoConfigService.readAllFiles(input.configId)
        return { summary, files }
      } catch (err) {
        if (err instanceof RepoConfigError && err.code === 'not_found') {
          throw new TRPCError({ code: 'NOT_FOUND', cause: err })
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' })
      }
    }),
})
