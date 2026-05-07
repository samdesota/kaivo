import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { getAppRealtime } from '../../realtime/app-realtime.js'
import { protectedProcedure, router } from '../trpc.js'

export const syncRouter = router({
  snapshot: protectedProcedure
    .input(z.object({ table: z.string().min(1) }))
    .query(({ input }) => getAppRealtime().snapshot(input.table)),

  changes: protectedProcedure
    .input(z.object({
      afterSeq: z.number().int().min(0),
      tables: z.array(z.string().min(1)).min(1).optional(),
    }))
    .subscription(({ input }) => {
      return observable((emit) => {
        const realtime = getAppRealtime()
        const missed = realtime.changes(input.afterSeq, input.tables)
        if (missed.length > 0) emit.next(missed)
        return realtime.subscribe((events) => {
          const filtered = input.tables?.length
            ? events.filter((event) => input.tables!.includes(event.table))
            : events
          if (filtered.length > 0) emit.next(filtered)
        })
      })
    }),
})
