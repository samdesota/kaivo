import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { getEnvRealtime } from '../../realtime/env-realtime.js'
import { authedProcedure, router } from '../trpc.js'

export const syncRouter = router({
  snapshot: authedProcedure
    .input(z.object({ table: z.string().min(1) }))
    .query(({ input }) => getEnvRealtime().snapshot(input.table)),

  changes: authedProcedure
    .input(z.object({
      afterSeq: z.number().int().min(0),
      tables: z.array(z.string().min(1)).min(1).optional(),
    }))
    .subscription(({ input }) => {
      return observable((emit) => {
        const realtime = getEnvRealtime()
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
