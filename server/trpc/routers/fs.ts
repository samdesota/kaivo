import { TRPCError } from '@trpc/server'
import { observable } from '@trpc/server/observable'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import {
  FsError,
  listDirectory,
  readFile,
  watchSandbox,
  writeFile,
  type FsEvent,
} from '../../fs/service.js'
import { sandboxManager } from '../../sandbox/manager.js'
import { terminalService } from '../../terminal/service.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof FsError) {
    const code: TRPCError['code'] =
      err.code === 'not_found'
        ? 'NOT_FOUND'
        : err.code === 'path_traversal'
          ? 'BAD_REQUEST'
          : err.code === 'not_readable'
            ? 'BAD_REQUEST'
            : 'INTERNAL_SERVER_ERROR'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'fs error',
  })
}

async function requireSandbox(id: string) {
  const sb = await sandboxManager.get(id)
  if (!sb) throw new TRPCError({ code: 'NOT_FOUND', message: 'sandbox not found' })
  return sb
}

const pathSchema = z.string().min(1).max(4096)

export const fsRouter = router({
  list: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1), path: pathSchema }))
    .query(async ({ input }) => {
      await requireSandbox(input.sandboxId)
      try {
        return await listDirectory(input.sandboxId, input.path)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  read: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1), path: pathSchema }))
    .query(async ({ input }) => {
      await requireSandbox(input.sandboxId)
      try {
        return await readFile(input.sandboxId, input.path)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  write: protectedProcedure
    .input(
      z.object({
        sandboxId: z.string().min(1),
        path: pathSchema,
        content: z.string().max(5 * 1024 * 1024),
      }),
    )
    .mutation(async ({ input }) => {
      await requireSandbox(input.sandboxId)
      try {
        await writeFile(input.sandboxId, input.path, input.content)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  watch: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1) }))
    .subscription(({ input }) => {
      return observable<FsEvent>((emit) => {
        let unsubscribe: (() => void) | null = null
        ;(async () => {
          await requireSandbox(input.sandboxId)
          unsubscribe = watchSandbox(input.sandboxId, (evt) => emit.next(evt))
        })().catch((err) => emit.error(toTrpcError(err)))
        return () => {
          if (unsubscribe) unsubscribe()
        }
      })
    }),

  /**
   * Flat list of every regular file under /workspace, excluding heavy
   * directories (node_modules, .git, dist, build). Used by the command
   * palette to fuzzy-search for files. Capped at 5000 entries.
   */
  find: protectedProcedure
    .input(z.object({ sandboxId: z.string().min(1) }))
    .query(async ({ input }) => {
      await requireSandbox(input.sandboxId)
      const cmd = [
        'find /workspace -type f',
        "-not -path '*/node_modules/*'",
        "-not -path '*/.git/*'",
        "-not -path '*/dist/*'",
        "-not -path '*/build/*'",
        "-not -path '*/.next/*'",
        '| head -5000',
      ].join(' ')
      try {
        const res = await terminalService.runOnce({
          sandboxId: input.sandboxId,
          cmd,
          cwd: '/workspace',
          timeoutMs: 15_000,
        })
        // `find /workspace` yields container-absolute paths; the rest of
        // the fs router speaks workspace-relative paths (with leading "/"),
        // so normalize before returning.
        const paths = res.stdout
          .split('\n')
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
          .map((p) => (p.startsWith('/workspace/') ? p.slice('/workspace'.length) : p))
        return { paths, truncated: res.truncated }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  /**
   * Unified git diff for one or more files. `cwd` is the repo root to run
   * `git diff` in; defaults to /workspace. Compares the working tree against
   * `ref` (default HEAD). Empty diff → empty string.
   */
  diff: protectedProcedure
    .input(
      z.object({
        sandboxId: z.string().min(1),
        cwd: z.string().min(1).max(4096).optional(),
        ref: z.string().max(200).optional(),
        paths: z.array(z.string().min(1).max(4096)).max(200).optional(),
      }),
    )
    .query(async ({ input }) => {
      await requireSandbox(input.sandboxId)
      const cwd = input.cwd ?? '/workspace'
      const ref = input.ref ?? 'HEAD'
      // Build `git diff --no-color <ref> -- <paths>`. We shell-escape by
      // single-quoting since git path args can contain spaces.
      const pathArgs =
        input.paths && input.paths.length > 0
          ? ' -- ' + input.paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ')
          : ''
      const cmd = `git diff --no-color ${JSON.stringify(ref)}${pathArgs}`
      try {
        const res = await terminalService.runOnce({
          sandboxId: input.sandboxId,
          cmd,
          cwd,
          timeoutMs: 15_000,
        })
        return {
          diff: res.stdout,
          stderr: res.stderr,
          exitCode: res.exitCode,
          truncated: res.truncated,
        }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),
})
