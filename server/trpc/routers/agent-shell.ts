import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { router } from '../trpc.js'
import {
  agentShellProcedure,
  resolveAgentSandboxId,
} from '../middleware/agent-shell-auth.js'
import { ShellError, terminalService } from '../../terminal/service.js'
import { db } from '../../db/client.js'
import { shellSessions } from '../../db/schema.js'
import { logger } from '../../logger.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof ShellError) {
    const code: TRPCError['code'] =
      err.code === 'not_found'
        ? 'NOT_FOUND'
        : err.code === 'sandbox_unavailable'
          ? 'PRECONDITION_FAILED'
          : err.code === 'timeout'
            ? 'TIMEOUT'
            : 'INTERNAL_SERVER_ERROR'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'agent shell error',
  })
}

/**
 * Verify that a shell id belongs to the caller's sandbox. Checks both the
 * in-memory service (live shells) and the `shell_sessions` row as a
 * fallback. Throws `FORBIDDEN` on mismatch, `NOT_FOUND` if the shell is
 * unknown everywhere.
 */
async function assertShellInSandbox(shellId: string, sandboxId: string): Promise<void> {
  const info = terminalService.get(shellId)
  if (info) {
    if (info.sandboxId !== sandboxId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'shell not in this sandbox' })
    }
    return
  }
  const rows = await db
    .select({ sandboxId: shellSessions.sandboxId })
    .from(shellSessions)
    .where(eq(shellSessions.id, shellId))
    .limit(1)
  const row = rows[0]
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'shell not found' })
  if (row.sandboxId !== sandboxId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'shell not in this sandbox' })
  }
}

type RunOnceEvent =
  | { type: 'started'; shellId: string }
  | { type: 'stdout'; b64: string }
  | { type: 'stderr'; b64: string }
  | { type: 'exit'; code: number; truncated: boolean }

export const agentShellRouter = router({
  /**
   * Stream a one-off command in the sandbox. First event is `started` with
   * the new shell id; stdout/stderr chunks interleave; `exit` terminates
   * the stream. Unsubscribing mid-run kills the underlying shell.
   */
  runOnce: agentShellProcedure
    .input(
      z.object({
        sandboxId: z.string().min(1).optional(),
        cmd: z.string().min(1).max(65536),
        cwd: z.string().optional(),
        cols: z.number().int().min(10).max(500).optional(),
        rows: z.number().int().min(2).max(500).optional(),
        opencodeSessionId: z.string().optional(),
      }),
    )
    .subscription(({ ctx, input }) => {
      const sandboxId = resolveAgentSandboxId(ctx, input.sandboxId)
      return observable<RunOnceEvent>((emit) => {
        const ac = new AbortController()
        let settled = false

        let handle: ReturnType<typeof terminalService.runOnceStream>
        try {
          handle = terminalService.runOnceStream({
            sandboxId,
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

  /**
   * Open a persistent (pty) shell owned by the agent. Appears in the
   * regular Shells panel with `owner_kind='agent'`.
   */
  open: agentShellProcedure
    .input(
      z.object({
        sandboxId: z.string().min(1).optional(),
        cwd: z.string().optional(),
        cols: z.number().int().min(10).max(500).optional(),
        rows: z.number().int().min(2).max(500).optional(),
        opencodeSessionId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sandboxId = resolveAgentSandboxId(ctx, input.sandboxId)
      try {
        const info = await terminalService.create({
          sandboxId,
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

  /** Send bytes to a persistent agent shell. */
  write: agentShellProcedure
    .input(
      z.object({
        sandboxId: z.string().min(1).optional(),
        shellId: z.string().min(1),
        b64: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sandboxId = resolveAgentSandboxId(ctx, input.sandboxId)
      await assertShellInSandbox(input.shellId, sandboxId)
      const info = terminalService.get(input.shellId)
      if (!info || !info.alive) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'shell not running' })
      }
      const data = Buffer.from(input.b64, 'base64').toString('utf8')
      terminalService.sendKeys(input.shellId, data)
      return { ok: true as const }
    }),

  /** Dispose a persistent agent shell. */
  close: agentShellProcedure
    .input(
      z.object({
        sandboxId: z.string().min(1).optional(),
        shellId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const sandboxId = resolveAgentSandboxId(ctx, input.sandboxId)
      await assertShellInSandbox(input.shellId, sandboxId)
      terminalService.dispose(input.shellId)
      return { ok: true as const }
    }),

  /**
   * Return the tail of a shell's scrollback plus its exit code if known.
   * Useful for agents that need to read output without attaching.
   */
  tail: agentShellProcedure
    .input(
      z.object({
        sandboxId: z.string().min(1).optional(),
        shellId: z.string().min(1),
        maxBytes: z.number().int().positive().max(1024 * 1024).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const sandboxId = resolveAgentSandboxId(ctx, input.sandboxId)
      await assertShellInSandbox(input.shellId, sandboxId)
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
