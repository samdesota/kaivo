import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import { RepoConfigError, repoConfigService } from '../../repo/configs.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof RepoConfigError) {
    const code: TRPCError['code'] =
      err.code === 'not_found'
        ? 'NOT_FOUND'
        : err.code === 'name_conflict' || err.code === 'path_conflict'
          ? 'CONFLICT'
          : 'BAD_REQUEST'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'repo config error',
  })
}

const createInput = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('url'),
    url: z.string().min(1).max(2048),
    name: z.string().max(200).optional(),
    ref: z.string().max(256).optional(),
  }),
  z.object({
    source: z.literal('github'),
    repoFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'must be owner/name'),
    name: z.string().max(200).optional(),
    ref: z.string().max(256).optional(),
  }),
])

export const repoConfigRouter = router({
  list: protectedProcedure.query(async () => repoConfigService.list()),

  get: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ input }) => repoConfigService.get(input.id)),

  create: protectedProcedure.input(createInput).mutation(async ({ input }) => {
    try {
      if (input.source === 'url') {
        return await repoConfigService.create({
          source: 'url',
          url: input.url,
          name: input.name,
          ref: input.ref,
        })
      }
      return await repoConfigService.create({
        source: 'github',
        repoFullName: input.repoFullName,
        name: input.name,
        ref: input.ref,
      })
    } catch (err) {
      throw toTrpcError(err)
    }
  }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().max(200).optional(),
        ref: z.string().max(256).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await repoConfigService.update(input.id, { name: input.name, ref: input.ref })
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await repoConfigService.remove(input.id)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  listFiles: protectedProcedure
    .input(z.object({ configId: z.string().min(1) }))
    .query(async ({ input }) => repoConfigService.listFiles(input.configId)),

  readFile: protectedProcedure
    .input(z.object({ configId: z.string().min(1), fileId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        return await repoConfigService.readFile(input.configId, input.fileId)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  putFile: protectedProcedure
    .input(
      z.object({
        configId: z.string().min(1),
        fileId: z.string().min(1).optional(),
        path: z.string().min(1).max(1024),
        contents: z.string().max(1_048_576),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        return await repoConfigService.putFile(input)
      } catch (err) {
        throw toTrpcError(err)
      }
    }),

  removeFile: protectedProcedure
    .input(z.object({ configId: z.string().min(1), fileId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      try {
        await repoConfigService.removeFile(input.configId, input.fileId)
        return { ok: true as const }
      } catch (err) {
        throw toTrpcError(err)
      }
    }),
})
