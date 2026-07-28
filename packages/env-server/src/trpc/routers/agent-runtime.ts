import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { AGENT_SESSION_RUNTIME_TABLE, getAgentRuntimeRealtime, type AgentSessionRuntimeRow } from '../../agent/runtime-realtime.js'
import { authedProcedure, router } from '../trpc.js'

export const agentRuntimeRouter = router({
  snapshot: authedProcedure
    .input(z.object({ workspaceId: z.string().min(1).optional() }).optional())
    .query(({ input }) => {
      const snapshot = getAgentRuntimeRealtime().snapshot<AgentSessionRuntimeRow>(AGENT_SESSION_RUNTIME_TABLE)
      return {
        ...snapshot,
        rows: input?.workspaceId ? snapshot.rows.filter((row) => row.workspaceId === input.workspaceId) : snapshot.rows,
      }
    }),

  changes: authedProcedure
    .input(z.object({ afterSeq: z.number().int().min(0), workspaceId: z.string().min(1).optional() }))
    .subscription(({ input }) => {
      return observable((emit) => {
        const realtime = getAgentRuntimeRealtime()
        const filter = (events: ReturnType<typeof realtime.changes>) => events.filter((event) => {
          if (event.table !== AGENT_SESSION_RUNTIME_TABLE) return false
          if (!input.workspaceId) return true
          const row = event.row as AgentSessionRuntimeRow | null
          if (!row) return true
          return row?.workspaceId === input.workspaceId
        })
        const unsubscribe = realtime.subscribe((events) => {
          const filtered = filter(events)
          if (filtered.length > 0) emit.next(filtered)
        })
        const missed = filter(realtime.changes(input.afterSeq, [AGENT_SESSION_RUNTIME_TABLE]))
        if (missed.length > 0) emit.next(missed)
        return unsubscribe
      })
    }),
})
