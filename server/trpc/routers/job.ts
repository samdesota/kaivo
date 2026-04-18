import { observable } from '@trpc/server/observable'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import { jobManager, type Job, type JobUpdate } from '../../jobs/manager.js'

interface JobSnapshot {
  type: 'snapshot'
  job: Job
}

export const jobRouter = router({
  get: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => {
      const job = await jobManager.getOrLoad(input.id)
      if (!job) throw new TRPCError({ code: 'NOT_FOUND' })
      return job
    }),

  listBySandbox: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1) }))
    .query(async ({ input }) => jobManager.listBySandbox(input.sandboxId)),

  watch: protectedProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .subscription(({ input }) => {
      return observable<JobSnapshot | JobUpdate>((emit) => {
        let unsubscribe: (() => void) | null = null
        ;(async () => {
          const job = await jobManager.getOrLoad(input.jobId)
          if (!job) {
            emit.error(new TRPCError({ code: 'NOT_FOUND' }))
            return
          }
          emit.next({ type: 'snapshot', job })
          unsubscribe = jobManager.subscribe(input.jobId, (u) => emit.next(u))
        })().catch((err) => emit.error(err))
        return () => {
          if (unsubscribe) unsubscribe()
        }
      })
    }),
})
