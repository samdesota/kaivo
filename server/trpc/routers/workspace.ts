import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import { WorkspaceError, workspaceService } from '../../workspace/service.js'

const workspaceTabSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().min(1), type: z.literal('shell'), envId: z.string().min(1), shellId: z.string().min(1), title: z.string() }),
  z.object({ id: z.string().min(1), type: z.literal('file'), envId: z.string().min(1), path: z.string().min(1), sessionId: z.string().min(1).optional(), title: z.string() }),
  z.object({ id: z.string().min(1), type: z.literal('preview'), envId: z.string().min(1), port: z.number().int().min(1).max(65535), title: z.string() }),
  z.object({ id: z.string().min(1), type: z.literal('browser'), url: z.string().min(1), browserTabId: z.string().min(1).optional(), title: z.string() }),
])

const uiStateSchema = z.object({
  activeAgentSessionId: z.string().min(1).nullable(),
  activeWorkspaceTabId: z.string().min(1).nullable(),
  workspaceTabs: z.array(workspaceTabSchema),
  splitRatio: z.number().min(0).max(1).nullable(),
  agentCollapsed: z.boolean(),
  tabOrder: z.array(z.string().min(1)),
})

const viewStatePatchSchema = z.object({
  activeAgentSessionId: z.string().min(1).nullable().optional(),
  activeWorkspaceTabId: z.string().min(1).nullable().optional(),
  splitRatio: z.number().min(0).max(1).nullable().optional(),
  agentCollapsed: z.boolean().optional(),
})

function toTrpcError(err: unknown): TRPCError {
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

export const workspaceRouter = router({
  list: protectedProcedure.query(async () => workspaceService.list()),

  get: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await workspaceService.get(input.id)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  create: protectedProcedure
    .input(z.object({ name: z.string().max(200).optional() }).optional())
    .mutation(async ({ input }) => workspaceService.create(input)),

  rename: protectedProcedure
    .input(z.object({ id: z.string().min(1), name: z.string().max(200) }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.rename(input.id, input.name)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  archive: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await workspaceService.archive(input.id)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  markOpened: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.markOpened(input.id)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  getUiState: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await workspaceService.getUiState(input.workspaceId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  getViewState: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await workspaceService.getViewState(input.workspaceId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  saveViewState: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), state: viewStatePatchSchema }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.saveViewState(input.workspaceId, input.state)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  saveUiState: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), state: uiStateSchema }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.saveUiState(input.workspaceId, input.state)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),
})

export type WorkspaceRouter = typeof workspaceRouter
