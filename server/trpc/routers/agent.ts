import { observable } from '@trpc/server/observable'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import {
  AgentError,
  agentService,
  type TranscriptEvent,
} from '../../agent/service.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof AgentError) {
    const code: TRPCError['code'] =
      err.code === 'not_found'
        ? 'NOT_FOUND'
        : err.code === 'no_provider' || err.code === 'sandbox_unavailable'
          ? 'BAD_REQUEST'
          : err.code === 'not_ready' || err.code === 'unavailable'
            ? 'PRECONDITION_FAILED'
            : 'INTERNAL_SERVER_ERROR'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'agent error',
  })
}

export const agentRouter = router({
  agentStatus: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1) }))
    .query(async ({ input }) => agentService.agentStatus(input.sandboxId)),

  startAgent: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await agentService.startAgent(input.sandboxId)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionList: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1) }))
    .query(({ input }) => agentService.sessionList(input.sandboxId)),

  sessionStart: protectedProcedure
    .input(
      z.object({
        sandboxId: z.string().min(1),
        prompt: z.string().min(1).max(100_000),
        title: z.string().min(1).max(200).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await agentService.sessionStart(input)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionSend: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        message: z.string().min(1).max(100_000),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await agentService.sessionSend(input)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionStatus: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await agentService.sessionStatus(input)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionApprove: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        permissionId: z.string().min(1),
        always: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await agentService.sessionRespond({
          sessionId: input.sessionId,
          permissionId: input.permissionId,
          response: input.always ? 'always' : 'once',
        })
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionReject: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        permissionId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await agentService.sessionRespond({
          sessionId: input.sessionId,
          permissionId: input.permissionId,
          response: 'reject',
        })
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  transcript: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .subscription(({ input }) => {
      return observable<TranscriptEvent>((emit) => {
        const unsub = agentService.subscribeTranscript(input.sessionId, (evt) => emit.next(evt))
        return () => unsub()
      })
    }),
})
