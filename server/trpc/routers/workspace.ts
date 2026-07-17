import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import { WorkspaceError, workspaceService } from '../../workspace/service.js'

const workspaceTabSchema = z.discriminatedUnion('type', [
  z.object({ id: z.string().min(1), type: z.literal('shell'), envId: z.string().min(1), shellId: z.string().min(1), title: z.string(), titleSource: z.enum(['auto', 'explicit']).optional() }),
  z.object({ id: z.string().min(1), type: z.literal('file'), envId: z.string().min(1), path: z.string().min(1), sessionId: z.string().min(1).optional(), title: z.string() }),
  z.object({ id: z.string().min(1), type: z.literal('browser'), url: z.string().min(1), browserTabId: z.string().min(1).optional(), faviconUrl: z.string().min(1).optional(), title: z.string() }),
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

export const workspaceResourceSchema = z.object({
  type: z.enum(['browser_tab', 'worktree', 'shell', 'other']),
  resourceKey: z.string().min(1).max(1_000),
  shared: z.boolean().optional(),
  data: z.record(z.unknown()).optional(),
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

  listTree: protectedProcedure.query(async () => workspaceService.listTree()),

  createFolder: protectedProcedure
    .input(z.object({ name: z.string().max(200), parentId: z.string().min(1).nullable().optional() }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.createFolder(input)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  renameFolder: protectedProcedure
    .input(z.object({ id: z.string().min(1), name: z.string().max(200) }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.renameFolder(input.id, input.name)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  archiveFolder: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await workspaceService.archiveFolder(input.id)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  setFolderCollapsed: protectedProcedure
    .input(z.object({ id: z.string().min(1), collapsed: z.boolean() }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.setFolderCollapsed(input.id, input.collapsed)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  moveSidebarNode: protectedProcedure
    .input(z.object({
      nodeType: z.enum(['folder', 'workspace']),
      nodeId: z.string().min(1),
      parentFolderId: z.string().min(1).nullable().optional(),
      beforeNodeId: z.string().min(1).nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.moveSidebarNode(input)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await workspaceService.get(input.id)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  getOrCreateGlobalTabsWorkspace: protectedProcedure.mutation(async () => {
    try {
      return await workspaceService.getOrCreateGlobalTabsWorkspace()
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  create: protectedProcedure
    .input(z.object({
      name: z.string().max(200).optional(),
      folderId: z.string().min(1).nullable().optional(),
      nameSource: z.enum(['explicit', 'folder_path', 'worktree', 'derived']).optional(),
      sourceKind: z.enum(['folder', 'worktree', 'repo_config']).nullable().optional(),
      sourcePath: z.string().max(4_096).nullable().optional(),
    }).optional())
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

  maybeAutoNameFromPrompt: protectedProcedure
    .input(z.object({
      id: z.string().min(1),
      prompt: z.string().min(1).max(100_000),
      isFirstChat: z.boolean(),
      chatHadExplicitTitle: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.maybeAutoNameFromPrompt(input)
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

  listTabs: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await workspaceService.listTabs(input.workspaceId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  upsertTab: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), tab: workspaceTabSchema, position: z.number().int().min(0) }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.upsertTab(input.workspaceId, { tab: input.tab, position: input.position })
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  deleteTab: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), tabId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await workspaceService.deleteTab(input.workspaceId, input.tabId)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  listAgentTabs: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await workspaceService.listAgentTabs(input.workspaceId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  upsertAgentTab: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), sessionId: z.string().min(1), position: z.number().int().min(0) }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.upsertAgentTab(input.workspaceId, { sessionId: input.sessionId, position: input.position })
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  deleteAgentTab: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), sessionId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await workspaceService.deleteAgentTab(input.workspaceId, input.sessionId)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  listResources: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1).optional() }).optional())
    .query(async ({ input }) => {
      try {
        return await workspaceService.listResources(input?.workspaceId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  upsertResource: protectedProcedure
    .input(z.object({ workspaceId: z.string().min(1), resource: workspaceResourceSchema }))
    .mutation(async ({ input }) => {
      try {
        return await workspaceService.upsertResource(input.workspaceId, input.resource)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  deleteResource: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await workspaceService.deleteResource(input.id)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  dismissAgentNotification: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await workspaceService.dismissAgentNotification(input.id)
      return { ok: true as const }
    }),

  dismissAgentNotificationsForSession: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      await workspaceService.dismissAgentNotificationsForSession(input.sessionId)
      return { ok: true as const }
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
