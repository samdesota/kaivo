import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { WalkthroughError, walkthroughService } from '../../walkthrough/service.js'
import type { WalkthroughEvent } from '../../walkthrough/contracts.js'
import { authedProcedure, router } from '../trpc.js'

const idSchema = z.string().min(1).max(200)
const branchComparisonSchema = z.object({
  kind: z.literal('branch'),
  originBranch: z.string().min(1).max(1024).nullable(),
  includeUncommitted: z.boolean(),
}).strict()
const comparisonSchema = z.discriminatedUnion('kind', [
  branchComparisonSchema,
  z.object({ kind: z.literal('working-tree'), branch: branchComparisonSchema }).strict(),
])

function toTrpcError(error: unknown): TRPCError {
  if (error instanceof WalkthroughError) {
    const code: TRPCError['code'] = error.code === 'not_found'
      ? 'NOT_FOUND'
      : error.code === 'git_error'
        ? 'INTERNAL_SERVER_ERROR'
        : 'PRECONDITION_FAILED'
    return new TRPCError({ code, message: error.message, cause: error })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: error instanceof Error ? error.message : 'walkthrough operation failed',
    cause: error,
  })
}

export const walkthroughRouter = router({
  start: authedProcedure.input(z.object({
    requestKey: z.string().min(1).max(200),
    cwd: z.string().min(1).max(4096),
    comparison: comparisonSchema,
  }).strict()).mutation(async ({ input }) => {
    try {
      return await walkthroughService.start(input)
    } catch (error) {
      throw toTrpcError(error)
    }
  }),

  snapshot: authedProcedure.input(z.object({ walkthroughId: idSchema }).strict()).query(({ input }) => {
    try {
      return walkthroughService.snapshot(input.walkthroughId)
    } catch (error) {
      throw toTrpcError(error)
    }
  }),

  events: authedProcedure.input(z.object({
    walkthroughId: idSchema,
    afterSeq: z.number().int().min(0),
  }).strict()).subscription(({ input }) => {
    return observable<WalkthroughEvent>((emit) => {
      let replaying = true
      let cursor = input.afterSeq
      const buffered: WalkthroughEvent[] = []
      let unsubscribe: (() => void) | undefined
      try {
        unsubscribe = walkthroughService.subscribe(input.walkthroughId, (event) => {
          if (event.sequence <= cursor) return
          if (replaying) buffered.push(event)
          else {
            cursor = event.sequence
            emit.next(event)
          }
        })
        const replay = walkthroughService.events(input.walkthroughId, input.afterSeq)
        for (const event of [...replay, ...buffered].sort((left, right) => left.sequence - right.sequence)) {
          if (event.sequence <= cursor) continue
          cursor = event.sequence
          emit.next(event)
        }
        replaying = false
      } catch (error) {
        unsubscribe?.()
        emit.error(toTrpcError(error))
      }
      return () => unsubscribe?.()
    })
  }),

  cancel: authedProcedure.input(z.object({ walkthroughId: idSchema }).strict()).mutation(({ input }) => {
    try {
      walkthroughService.cancel(input.walkthroughId)
      return { ok: true as const }
    } catch (error) {
      throw toTrpcError(error)
    }
  }),
})
