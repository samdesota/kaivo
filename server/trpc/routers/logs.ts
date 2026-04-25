import { z } from 'zod'
import { identityProcedure, protectedProcedure, router } from '../trpc.js'
import { ingestLogs } from '../../logs/service.js'

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const

const entrySchema = z.object({
  // ms since epoch — stays portable across JSON / superjson Date drift.
  ts: z.number().int().nonnegative(),
  level: z.enum(LEVELS),
  msg: z.string().max(64 * 1024),
  ctx: z.record(z.string(), z.unknown()).nullable().optional(),
})

const batchSchema = z.object({
  // Free-form source tag set by the caller (e.g. "cc-env", "browser").
  // The server will namespace browser-supplied sources to "browser:*"
  // since we can't trust the value.
  source: z.string().min(1).max(64).optional(),
  entries: z.array(entrySchema).min(1).max(500),
})

export const logsRouter = router({
  /**
   * Env-server / sandbox / install.sh ingest. Auth = identityToken bearer.
   * Source defaults to the auth label for traceability; can be overridden
   * (e.g. cc-env reports its own kind/label).
   */
  ingest: identityProcedure
    .input(batchSchema)
    .mutation(async ({ ctx, input }) => {
      const source = input.source ?? `env:${ctx.envAuth.label}`
      return ingestLogs({
        source,
        principal: ctx.envAuth.tokenHash,
        entries: input.entries.map((e) => ({
          ts: new Date(e.ts),
          level: e.level,
          msg: e.msg,
          ctx: e.ctx ?? null,
        })),
      })
    }),

  /**
   * Browser ingest. Auth = web session cookie. Source is forced to
   * "browser" so a logged-in user can't pose as cc-env or orchestrator.
   */
  ingestBrowser: protectedProcedure
    .input(batchSchema.omit({ source: true }))
    .mutation(async ({ ctx, input }) => {
      return ingestLogs({
        source: 'browser',
        principal: `session:${ctx.session.id}`,
        entries: input.entries.map((e) => ({
          ts: new Date(e.ts),
          level: e.level,
          msg: e.msg,
          ctx: e.ctx ?? null,
        })),
      })
    }),
})
