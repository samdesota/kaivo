import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { agentShellProcedure, router } from '../trpc.js'
import { ShellError, ensureValidCwd, resolveWorkspaceIdForShellOwner, terminalService } from '../../terminal/service.js'
import { terminalDaemonClient, useTerminalDaemon } from '../../terminal/daemon-client.js'
import { logger } from '../../logger.js'
import { upsertWorkspaceResource } from '../../identity/client.js'
import { agentService } from '../../agent/service.js'

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

async function getWorkspaceShell(input: {
  shellId: string
  opencodeSessionId?: string | null
  ownerAgentSessionId?: string | null
}) {
  const ownerSessionId = input.opencodeSessionId
    ? agentService.resolveRootOpencodeSessionId(input.opencodeSessionId)
    : null
  const workspaceId = resolveWorkspaceIdForShellOwner({
    ownerAgentSessionId: input.ownerAgentSessionId ?? null,
    ownerSessionId,
  })
  if (!workspaceId) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'agent session has no workspace' })
  }

  const info = useTerminalDaemon() ? await terminalDaemonClient.get(input.shellId) : terminalService.get(input.shellId)
  if (!info || info.workspaceId !== workspaceId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'shell not found in this workspace' })
  }
  return info
}

export const agentShellRouter = router({
  list: agentShellProcedure
    .input(
      z.object({
        opencodeSessionId: z.string().optional(),
        ownerAgentSessionId: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const ownerSessionId = input.opencodeSessionId
        ? agentService.resolveRootOpencodeSessionId(input.opencodeSessionId)
        : null
      const workspaceId = resolveWorkspaceIdForShellOwner({
        ownerAgentSessionId: input.ownerAgentSessionId ?? null,
        ownerSessionId,
      })
      if (!workspaceId) return []
      return useTerminalDaemon()
        ? await terminalDaemonClient.list({ workspaceId })
        : terminalService.list({ workspaceId })
    }),

  runOnce: agentShellProcedure
    .input(
      z.object({
        cmd: z.string().min(1).max(65536),
        cwd: z.string().optional(),
        workspaceId: z.string().optional(),
        cols: z.number().int().min(10).max(500).optional(),
        rows: z.number().int().min(2).max(500).optional(),
        opencodeSessionId: z.string().optional(),
        ownerAgentSessionId: z.string().optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<RunOnceEvent>((emit) => {
        const ac = new AbortController()
        let settled = false

        let handle: ReturnType<typeof terminalService.runOnceStream>
        try {
          const ownerSessionId = input.opencodeSessionId
            ? agentService.resolveRootOpencodeSessionId(input.opencodeSessionId)
            : null
          handle = terminalService.runOnceStream({
            cmd: input.cmd,
            workspaceId: input.workspaceId ?? null,
            cwd: input.cwd,
            cols: input.cols,
            rows: input.rows,
            ownerSessionId,
            ownerAgentSessionId: input.ownerAgentSessionId ?? null,
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
        workspaceId: z.string().optional(),
        cols: z.number().int().min(10).max(500).optional(),
        rows: z.number().int().min(2).max(500).optional(),
        opencodeSessionId: z.string().optional(),
        ownerAgentSessionId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        if (input.cwd) ensureValidCwd(input.cwd)
        const ownerSessionId = input.opencodeSessionId
          ? agentService.resolveRootOpencodeSessionId(input.opencodeSessionId)
          : null
        const info = await (useTerminalDaemon() ? terminalDaemonClient.create({
          workspaceId: input.workspaceId ?? null,
          cwd: input.cwd,
          cols: input.cols,
          rows: input.rows,
          ownerKind: 'agent',
          ownerSessionId,
          ownerAgentSessionId: input.ownerAgentSessionId ?? null,
        }) : terminalService.create({
          workspaceId: input.workspaceId ?? null,
          cwd: input.cwd,
          cols: input.cols,
          rows: input.rows,
          ownerKind: 'agent',
          ownerSessionId,
          ownerAgentSessionId: input.ownerAgentSessionId ?? null,
        }))
        const workspaceId = info.workspaceId ?? input.workspaceId
        if (workspaceId) {
          void upsertWorkspaceResource({
            workspaceId,
            resource: {
              type: 'shell',
              resourceKey: info.id,
              shared: false,
              data: { shellId: info.id, cwd: info.cwd, ownerKind: 'agent' },
            },
          }).catch((err) => logger.warn({ err, shellId: info.id, workspaceId }, 'workspace shell resource registration failed'))
        }
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
        opencodeSessionId: z.string().optional(),
        ownerAgentSessionId: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const info = await getWorkspaceShell(input)
      if (!info || !info.alive) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'shell not running' })
      }
      const data = Buffer.from(input.b64, 'base64').toString('utf8')
      if (useTerminalDaemon()) await terminalDaemonClient.write(input.shellId, data)
      else terminalService.sendKeys(input.shellId, data)
      return { ok: true as const }
    }),

  close: agentShellProcedure
    .input(z.object({ shellId: z.string().min(1), opencodeSessionId: z.string().optional(), ownerAgentSessionId: z.string().optional() }))
    .mutation(async ({ input }) => {
      await getWorkspaceShell(input)
      if (useTerminalDaemon()) await terminalDaemonClient.dispose(input.shellId)
      else terminalService.dispose(input.shellId)
      return { ok: true as const }
    }),

  tail: agentShellProcedure
    .input(
      z.object({
        shellId: z.string().min(1),
        maxBytes: z.number().int().positive().max(1024 * 1024).optional(),
        opencodeSessionId: z.string().optional(),
        ownerAgentSessionId: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const max = input.maxBytes ?? 64 * 1024
      const info = await getWorkspaceShell(input)
      if (useTerminalDaemon()) {
        try {
          const snap = await terminalDaemonClient.snapshot(input.shellId)
          const bytes = Buffer.from(snap.b64, 'base64')
          const tail = bytes.length > max ? bytes.subarray(bytes.length - max) : bytes
          return {
            b64: tail.toString('base64'),
            truncated: bytes.length > max,
            exitCode: snap.exitCode,
            alive: snap.alive,
          }
        } catch (err) {
          throw toTrpcError(err)
        }
      }
      const snap = terminalService.snapshot(input.shellId)
      if (snap === null) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'shell no longer retained' })
      }
      const bytes = Buffer.from(snap, 'utf8')
      const tail = bytes.length > max ? bytes.subarray(bytes.length - max) : bytes
      return {
        b64: tail.toString('base64'),
        truncated: bytes.length > max,
        exitCode: info.exitCode,
        alive: info.alive,
      }
    }),
})
