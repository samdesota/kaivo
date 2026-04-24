import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { agentShellProcedure, router } from '../trpc.js'
import { ShellError, terminalService } from '../../terminal/service.js'
import { logger } from '../../logger.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof ShellError) {
    const code: TRPCError['code'] =
      err.code === 'not_found'
        ? 'NOT_FOUND'
        : err.code === 'timeout'
          ? 'TIMEOUT'
          : 'BAD_REQUEST'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'agent shell error',
  })
}

type RunOnceEvent =
  | { type: 'started'; shellId: string }
  | { type: 'stdout'; b64: string }
  | { type: 'stderr'; b64: string }
  | { type: 'exit'; code: number; truncated: boolean }

export const agentShellRouter = router({
  runOnce: agentShellProcedure
    .input(
      z.object({
        cmd: z.string().min(1).max(65536),
        cwd: z.string().optional(),
        cols: z.number().int().min(10).max(500).optional(),
        rows: z.number().int().min(2).max(500).optional(),
        opencodeSessionId: z.string().optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<RunOnceEvent>((emit) => {
        const ac = new AbortController()
        let settled = false

        let handle: ReturnType<typeof terminalService.runOnceStream>
        try {
          handle = terminalService.runOnceStream({
            cmd: input.cmd,
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            ownerSessionId: input.opencodeSessionId ?? null,
            onStdout: (chunk) =>
              emit.next({ type: 'stdout', b64: chunk.toString('base64') }),
            onStderr: (chunk) =>
              emit.next({ type: 'stderr', b64: chunk.toString('base64') }),
            signal: ac.signal,
          })
        } catch (err) {
          emit.error(toTrpcError(err))
          return () => undefined
        }

        emit.next({ type: 'started', shellId: handle.shellId })

        handle.exitPromise
          .then((r) => {
            settled = true
            emit.next({ type: 'exit', code: r.exitCode, truncated: r.truncated })
            emit.complete()
          })
          .catch((err) => {
            settled = true
            emit.error(toTrpcError(err))
          })

        return () => {
          if (!settled) {
            ac.abort()
            handle.dispose().catch((err) => logger.warn({ err }, 'dispose failed'))
          }
        }
      })
    }),

  open: agentShellProcedure
    .input(
      z.object({
        cwd: z.string().optional(),
        cols: z.number().int().min(10).max(500).optional(),
        rows: z.number().int().min(2).max(500).optional(),
        opencodeSessionId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        const info = await terminalService.create({
          cwd: input.cwd,
          cols: input.cols,
          rows: input.rows,
          ownerKind: 'agent',
          ownerSessionId: input.opencodeSessionId ?? null,
        })
        return { shellId: info.id }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  write: agentShellProcedure
    .input(
      z.object({
        shellId: z.string().min(1),
        b64: z.string(),
      }),
    )
    .mutation(async ({ input }) => {
      const info = terminalService.get(input.shellId)
      if (!info || !info.alive) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'shell not running' })
      }
      const data = Buffer.from(input.b64, 'base64').toString('utf8')
      terminalService.sendKeys(input.shellId, data)
      return { ok: true as const }
    }),

  close: agentShellProcedure
    .input(z.object({ shellId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      terminalService.dispose(input.shellId)
      return { ok: true as const }
    }),

  tail: agentShellProcedure
    .input(
      z.object({
        shellId: z.string().min(1),
        maxBytes: z.number().int().positive().max(1024 * 1024).optional(),
      }),
    )
    .query(async ({ input }) => {
      const max = input.maxBytes ?? 64 * 1024
      const snap = terminalService.snapshot(input.shellId)
      if (snap === null) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'shell no longer retained' })
      }
      const bytes = Buffer.from(snap, 'utf8')
      const tail = bytes.length > max ? bytes.subarray(bytes.length - max) : bytes
      const info = terminalService.get(input.shellId)
      return {
        b64: tail.toString('base64'),
        truncated: bytes.length > max,
        exitCode: info?.exitCode ?? null,
        alive: info?.alive ?? false,
      }
    }),
})
