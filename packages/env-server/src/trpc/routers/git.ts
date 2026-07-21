import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { GitError, gitService } from '../../git/service.js'
import { authedProcedure, router } from '../trpc.js'

const cwdSchema = z.string().min(1).max(4096)

function toTrpcError(error: unknown): TRPCError {
  if (error instanceof GitError) {
    const code: TRPCError['code'] = error.code === 'not_repository'
      ? 'NOT_FOUND'
      : error.code === 'timeout'
        ? 'TIMEOUT'
        : error.code === 'command_failed' || error.code === 'output_limit'
          ? 'INTERNAL_SERVER_ERROR'
          : 'PRECONDITION_FAILED'
    return new TRPCError({ code, message: error.message, cause: error })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (error as { message?: string })?.message ?? 'Git operation failed',
  })
}

async function call<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw toTrpcError(error)
  }
}

export const gitRouter = router({
  discoverGit: authedProcedure
    .input(z.object({ cwd: cwdSchema }).strict())
    .query(({ input }) => call(() => gitService.discoverGit(input.cwd))),

  originBranches: authedProcedure
    .input(z.object({ cwd: cwdSchema }).strict())
    .query(({ input }) => call(() => gitService.originBranches(input.cwd))),

  diff: authedProcedure
    .input(z.discriminatedUnion('kind', [
      z.object({
        cwd: cwdSchema,
        kind: z.literal('branch'),
        originBranch: z.string().min(1).max(1024),
        includeUncommitted: z.boolean(),
      }).strict(),
      z.object({ cwd: cwdSchema, kind: z.literal('working-tree') }).strict(),
    ]))
    .query(({ input }) => call(() => gitService.diff(input))),
})
