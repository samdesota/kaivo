import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { paneContentSchema } from './agent-ui-schema.js'
import { identityProcedure, router } from '../trpc.js'
import { buildProviderEnvRaw } from '../../agent/providers.js'
import { RepoConfigError, repoConfigService } from '../../repo/configs.js'
import { WorkspaceError, workspaceService } from '../../workspace/service.js'

function toWorkspaceTrpcError(err: unknown): TRPCError {
  if (err instanceof WorkspaceError) {
    return new TRPCError({
      code: err.code === 'not_found' ? 'NOT_FOUND' : 'BAD_REQUEST',
      message: err.message,
      cause: err,
    })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'workspace error',
  })
}

/**
 * Env-facing surface on identity. Authenticated with a bearer identityToken
 * (see `identityProcedure`). Env servers call these to bootstrap opencode
 * and apply repo configs.
 */
export const envApiRouter = router({
  resolveProviderKeys: identityProcedure.query(async () => {
    return buildProviderEnvRaw()
  }),

  openPane: identityProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1),
        envId: z.string().min(1),
        content: paneContentSchema,
        title: z.string().max(120).optional(),
        activate: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const tab = await workspaceService.openPane(input.workspaceId, {
          envId: input.envId,
          content: input.content,
          title: input.title,
          activate: input.activate,
        })
        return { ok: true as const, tab }
      } catch (err) {
        throw toWorkspaceTrpcError(err)
      }
    }),

  createAgentNotification: identityProcedure
    .input(z.object({
      workspaceId: z.string().min(1),
      sessionId: z.string().min(1),
      kind: z.enum(['finished', 'question', 'permission', 'error']).optional(),
      title: z.string().min(1).max(120),
      summary: z.string().min(1).max(120),
    }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.createAgentNotification(input)
      } catch (err) {
        throw toWorkspaceTrpcError(err)
      }
    }),

  listWorkspaceBrowserTabs: identityProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        const tabs = await workspaceService.listTabs(input.workspaceId)
        return tabs
          .filter((tab) => tab.type === 'browser' && tab.browserTabId)
          .map((tab) => ({
            workspaceTabId: tab.id,
            browserTabId: tab.browserTabId!,
            url: tab.url ?? '',
            title: tab.title,
          }))
      } catch (err) {
        throw toWorkspaceTrpcError(err)
      }
    }),

  upsertWorkspaceResource: identityProcedure
    .input(z.object({
      workspaceId: z.string().min(1),
      resource: z.object({
        type: z.enum(['browser_tab', 'worktree', 'shell', 'other']),
        resourceKey: z.string().min(1).max(1_000),
        shared: z.boolean().optional(),
        data: z.record(z.unknown()).optional(),
      }),
    }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.upsertResource(input.workspaceId, input.resource)
      } catch (err) {
        throw toWorkspaceTrpcError(err)
      }
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
