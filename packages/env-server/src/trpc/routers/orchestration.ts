import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { dispatchSubtaskFromAgentSchema, dispatchSubtaskSchema, reportSubtaskDeliverySchema, type OrchestrationChange } from '../../orchestration/contracts.js'
import { OrchestrationError, orchestrationService } from '../../orchestration/service.js'
import { agentService } from '../../agent/service.js'
import { createAgentSessionCredentialForOpencodeSession } from '../../auth/session-credentials.js'
import { getOrchestrationRealtime } from '../../orchestration/realtime.js'
import { RepoConfigRequestError, repoConfigRequestService } from '../../orchestration/repo-config-request-service.js'
import { agentShellProcedure, authedProcedure, contextPrincipal, principalProcedure, router } from '../trpc.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err
  if (err instanceof OrchestrationError) {
    const code: TRPCError['code'] =
      err.code === 'not_found' ? 'NOT_FOUND'
        : err.code === 'forbidden' ? 'FORBIDDEN'
          : err.code === 'conflict' ? 'CONFLICT'
            : 'BAD_REQUEST'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  if (err instanceof RepoConfigRequestError) {
    const code: TRPCError['code'] = err.code === 'not_found' ? 'NOT_FOUND' : err.code === 'conflict' ? 'CONFLICT' : 'BAD_REQUEST'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: err instanceof Error ? err.message : 'orchestration error',
    cause: err,
  })
}

export const orchestrationRouter = router({
  startDispatch: authedProcedure.input(z.object({
    workspaceId: z.string().min(1),
    prompt: z.string().min(1).max(100_000).optional(),
    title: z.string().min(1).max(200).optional(),
    directory: z.string().min(1).max(4_096).optional(),
    model: z.object({
      providerID: z.string().min(1),
      modelID: z.string().min(1),
      variant: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']).nullable().optional(),
    }).optional(),
  })).mutation(async ({ input }) => agentService.sessionStartInternal({ ...input, kind: 'dispatch' })),

  bindAgentSession: agentShellProcedure.input(z.object({
    opencodeSessionId: z.string().min(1).max(500),
  })).mutation(({ input }) => createAgentSessionCredentialForOpencodeSession(input.opencodeSessionId)),

  dispatch: principalProcedure.input(dispatchSubtaskSchema).mutation(async ({ ctx, input }) => {
    try {
      const principal = contextPrincipal(ctx)
      if (!principal) throw new TRPCError({ code: 'UNAUTHORIZED' })
      return await orchestrationService.dispatch(principal, input)
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  dispatchFromAgent: principalProcedure.input(dispatchSubtaskFromAgentSchema).mutation(async ({ ctx, input }) => {
    try {
      const principal = contextPrincipal(ctx)
      if (!principal) throw new TRPCError({ code: 'UNAUTHORIZED' })
      return await orchestrationService.dispatchFromAgent(principal, input)
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  snapshot: principalProcedure.input(z.object({ workspaceId: z.string().min(1).max(200) })).query(({ ctx, input }) => {
    try {
      const principal = contextPrincipal(ctx)
      if (!principal) throw new TRPCError({ code: 'UNAUTHORIZED' })
      const cursor = getOrchestrationRealtime().cursor(input.workspaceId)
      return orchestrationService.snapshot(principal, input.workspaceId, cursor)
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  changes: principalProcedure.input(z.object({
    workspaceId: z.string().min(1).max(200),
    cursor: z.object({ generation: z.string(), seq: z.number().int().min(0) }),
  })).subscription(({ ctx, input }) => {
    const principal = contextPrincipal(ctx)
    if (!principal) throw new TRPCError({ code: 'UNAUTHORIZED' })
    orchestrationService.assertWorkspaceRead(principal, input.workspaceId)
    const realtime = getOrchestrationRealtime()
    return observable<OrchestrationChange>((emit) => {
      for (const change of realtime.changes(input.workspaceId, input.cursor)) emit.next(change)
      return realtime.subscribe((workspaceId, change) => {
        if (workspaceId === input.workspaceId) emit.next(change)
      })
    })
  }),

  dispatcherContext: principalProcedure.input(z.object({})).query(({ ctx }) => {
    try {
      const principal = contextPrincipal(ctx)
      if (!principal) throw new TRPCError({ code: 'UNAUTHORIZED' })
      return { context: orchestrationService.dispatcherContext(principal) }
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  pendingRepoConfigRequest: authedProcedure.input(z.object({
    workspaceId: z.string().min(1).max(200),
  })).query(({ input }) => repoConfigRequestService.pending(input.workspaceId)),

  claimRepoConfigRequest: authedProcedure.input(z.object({
    workspaceId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
    claimId: z.string().min(1).max(200),
  })).mutation(({ input }) => {
    try {
      return repoConfigRequestService.claim(input)
    } catch (error) {
      throw toTrpcError(error)
    }
  }),

  completeRepoConfigRequest: authedProcedure.input(z.object({
    workspaceId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
    claimId: z.string().min(1).max(200),
    configId: z.string().min(1).max(200),
  })).mutation(({ input }) => {
    try {
      repoConfigRequestService.complete(input)
      return { ok: true as const }
    } catch (error) {
      throw toTrpcError(error)
    }
  }),

  cancelRepoConfigRequest: authedProcedure.input(z.object({
    workspaceId: z.string().min(1).max(200),
    requestId: z.string().min(1).max(200),
    claimId: z.string().min(1).max(200),
  })).mutation(({ input }) => {
    try {
      repoConfigRequestService.cancel(input)
      return { ok: true as const }
    } catch (error) {
      throw toTrpcError(error)
    }
  }),

  reportDelivery: principalProcedure.input(reportSubtaskDeliverySchema).mutation(({ ctx, input }) => {
    try {
      const principal = contextPrincipal(ctx)
      if (!principal) throw new TRPCError({ code: 'UNAUTHORIZED' })
      return orchestrationService.reportDelivery(principal, input)
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  complete: authedProcedure.input(z.object({
    workspaceId: z.string().min(1).max(200),
    subtaskId: z.string().min(1).max(200),
  })).mutation(({ ctx, input }) => {
    try {
      const principal = contextPrincipal(ctx)
      if (!principal) throw new TRPCError({ code: 'UNAUTHORIZED' })
      return orchestrationService.complete(principal, input)
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  retry: principalProcedure.input(z.object({
    workspaceId: z.string().min(1).max(200),
    subtaskId: z.string().min(1).max(200),
  })).mutation(async ({ ctx, input }) => {
    try {
      const principal = contextPrincipal(ctx)
      if (!principal) throw new TRPCError({ code: 'UNAUTHORIZED' })
      return await orchestrationService.retry(principal, input)
    } catch (err) {
      throw toTrpcError(err)
    }
  }),
})
