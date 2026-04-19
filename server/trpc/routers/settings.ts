import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import {
  SUPPORTED_PROVIDERS,
  deleteProvider,
  listProviders,
  setProviderApiKey,
  setProviderBaseUrl,
} from '../../agent/providers.js'

const providerEnum = z.enum(SUPPORTED_PROVIDERS as unknown as [string, ...string[]])

export const settingsRouter = router({
  listProviders: protectedProcedure.query(async () => listProviders()),

  setProviderKey: protectedProcedure
    .input(
      z.object({
        provider: providerEnum,
        apiKey: z.string().min(1).max(1_000),
        baseUrl: z.string().url().optional().nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      await setProviderApiKey(input.provider as 'anthropic' | 'openai', input.apiKey)
      if (input.baseUrl !== undefined) {
        await setProviderBaseUrl(input.provider as 'anthropic' | 'openai', input.baseUrl)
      }
      return { ok: true as const }
    }),

  setProviderBaseUrl: protectedProcedure
    .input(
      z.object({
        provider: providerEnum,
        baseUrl: z.string().url().nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      await setProviderBaseUrl(input.provider as 'anthropic' | 'openai', input.baseUrl)
      return { ok: true as const }
    }),

  deleteProvider: protectedProcedure
    .input(z.object({ provider: providerEnum }))
    .mutation(async ({ input }) => {
      await deleteProvider(input.provider as 'anthropic' | 'openai')
      return { ok: true as const }
    }),
})
