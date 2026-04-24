import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { eq } from 'drizzle-orm'
import { authedProcedure, router } from '../trpc.js'
import { db } from '../../db/client.js'
import { jobs } from '../../db/schema.js'

export const jobRouter = router({
  list: authedProcedure.query(() => {
    return db.select().from(jobs).all()
  }),

  get: authedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ input }) => {
      const rows = db.select().from(jobs).where(eq(jobs.id, input.id)).all()
      const row = rows[0]
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      return row
    }),
})
