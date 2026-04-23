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
  // Non-AgentError: OpenCode SDK 1.4.17's `throwOnError: true` throws
  // whatever the upstream body was — often a bare string, sometimes a
  // plain object like `{ message: "..." }`, sometimes a Response-shaped
  // thing. Drill through the obvious shapes and fall back to JSON so we
  // never surface "[object Object]" to the client.
  const msg = stringifyError(err)
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: msg,
    cause: err,
  })
}

function stringifyError(err: unknown): string {
  if (err == null) return 'agent error'
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message || err.name || 'agent error'
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>
    if (typeof o.message === 'string') return o.message
    if (typeof o.error === 'string') return o.error
    if (o.error && typeof (o.error as { message?: unknown }).message === 'string') {
      return (o.error as { message: string }).message
    }
    try {
      return JSON.stringify(err)
    } catch {
      // fall through
    }
  }
  return String(err)
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
        prompt: z.string().min(1).max(100_000).optional(),
        title: z.string().min(1).max(200).optional(),
        directory: z.string().min(1).max(4_096).optional(),
        model: z
          .object({ providerID: z.string().min(1), modelID: z.string().min(1) })
          .optional(),
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

  sessionMessages: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await agentService.sessionMessages(input.sessionId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  childTranscripts: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await agentService.childTranscripts(input.sessionId)
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

  sessionAnswerQuestion: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        requestId: z.string().min(1),
        answers: z.array(z.array(z.string().max(10_000))).min(1),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await agentService.sessionAnswerQuestion(input)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionRejectQuestion: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1), requestId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await agentService.sessionRejectQuestion(input)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionAbort: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await agentService.sessionAbort(input)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionRename: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        title: z.string().min(1).max(200),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await agentService.sessionRename(input)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  listModels: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await agentService.listModels(input.sandboxId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionSetModel: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        providerID: z.string().min(1).max(100).nullable(),
        modelID: z.string().min(1).max(200).nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      if (input.providerID && input.modelID) {
        await agentService.setSessionModel(input.sessionId, {
          providerID: input.providerID,
          modelID: input.modelID,
        })
      } else {
        await agentService.setSessionModel(input.sessionId, null)
      }
      return { ok: true as const }
    }),

  sessionGetModel: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input }) => {
      return agentService.getSessionModel(input.sessionId)
    }),

  listCommands: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await agentService.listCommands(input.sandboxId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  runCommand: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        command: z.string().min(1).max(200),
        arguments: z.string().max(100_000).default(''),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await agentService.runCommand(input)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionClose: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await agentService.sessionSetStatus({
          sessionId: input.sessionId,
          status: 'archived',
        })
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionReopen: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        return await agentService.sessionSetStatus({
          sessionId: input.sessionId,
          status: 'active',
        })
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
