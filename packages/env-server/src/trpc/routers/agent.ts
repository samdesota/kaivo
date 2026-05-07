import { observable } from '@trpc/server/observable'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { authedProcedure, router } from '../trpc.js'
import { AgentError, agentService, type TranscriptEvent } from '../../agent/service.js'

const reasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof AgentError) {
    const code: TRPCError['code'] =
      err.code === 'not_found'
        ? 'NOT_FOUND'
        : err.code === 'no_provider'
          ? 'BAD_REQUEST'
          : err.code === 'not_ready' || err.code === 'unavailable'
            ? 'PRECONDITION_FAILED'
            : 'INTERNAL_SERVER_ERROR'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  const msg = stringifyError(err)
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg, cause: err })
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
  agentStatus: authedProcedure.query(async () => agentService.agentStatus()),

  /**
   * Explicit (re)start of opencode. Called from the webapp after provider
   * keys change in identity settings, or when the user clicks "retry".
   */
  startAgent: authedProcedure.mutation(async () => {
    try {
      await agentService.startAgent()
      return { ok: true as const }
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  restart: authedProcedure.mutation(async () => {
    try {
      await agentService.startAgent()
      return { ok: true as const }
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  openAIOAuthStatus: authedProcedure.query(() => agentService.openAIOAuthStatusGet()),

  openAIOAuthStart: authedProcedure.mutation(async () => {
    try {
      return await agentService.openAIOAuthStart()
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  sessionList: authedProcedure
    .input(z.object({ workspaceId: z.string().min(1).optional() }).optional())
    .query(({ input }) => agentService.sessionList(input ?? {})),

  workspaceChatSummary: authedProcedure
    .input(z.object({ workspaceIds: z.array(z.string().min(1)).max(200) }))
    .query(({ input }) => agentService.workspaceChatSummary(input)),

  sessionStart: authedProcedure
    .input(
      z.object({
        workspaceId: z.string().min(1).optional(),
        prompt: z.string().min(1).max(100_000).optional(),
        title: z.string().min(1).max(200).optional(),
        directory: z.string().min(1).max(4_096).optional(),
        model: z
          .object({
            providerID: z.string().min(1),
            modelID: z.string().min(1),
            variant: reasoningEffortSchema.nullable().optional(),
          })
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

  sessionSend: authedProcedure
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

  sessionStatus: authedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await agentService.sessionStatus(input)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionMessages: authedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await agentService.sessionMessages(input.sessionId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  childTranscripts: authedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await agentService.childTranscripts(input.sessionId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  transcriptReplay: authedProcedure
    .input(z.object({ sessionId: z.string().min(1), sinceSeq: z.number().int().min(0).default(0) }))
    .query(async ({ input }) => {
      try {
        return await agentService.transcriptReplay(input.sessionId, input.sinceSeq)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  transcriptLatestSeq: authedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await agentService.transcriptLatestSeq(input.sessionId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionApprove: authedProcedure
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

  sessionAnswerQuestion: authedProcedure
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

  sessionRejectQuestion: authedProcedure
    .input(z.object({ sessionId: z.string().min(1), requestId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await agentService.sessionRejectQuestion(input)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionAbort: authedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await agentService.sessionAbort(input)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  sessionRename: authedProcedure
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

  listModels: authedProcedure.query(async () => {
    try {
      return await agentService.listModels()
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  defaultModelGet: authedProcedure.query(() => agentService.getDefaultModel()),

  defaultModelSet: authedProcedure
    .input(
      z.object({
        providerID: z.string().min(1).max(100),
        modelID: z.string().min(1).max(200),
      }),
    )
    .mutation(({ input }) => {
      agentService.setDefaultModel(input)
      return { ok: true as const }
    }),

  sessionSetModel: authedProcedure
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

  sessionSetModelVariant: authedProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        variant: reasoningEffortSchema.nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      await agentService.setSessionModelVariant(input.sessionId, input.variant)
      return { ok: true as const }
    }),

  sessionGetModel: authedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input }) => {
      return agentService.getSessionModel(input.sessionId)
    }),

  listCommands: authedProcedure.query(async () => {
    try {
      return await agentService.listCommands()
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  runCommand: authedProcedure
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

  sessionClose: authedProcedure
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

  sessionReopen: authedProcedure
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

  sessionReject: authedProcedure
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

  transcript: authedProcedure
    .input(z.object({ sessionId: z.string().min(1), sinceSeq: z.number().int().min(0).default(0) }))
    .subscription(({ input }) => {
      return observable<TranscriptEvent>((emit) => {
        const unsub = agentService.subscribeTranscript(
          input.sessionId,
          (evt) => emit.next(evt),
          input.sinceSeq,
        )
        return () => unsub()
      })
    }),
})
