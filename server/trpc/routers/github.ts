import crypto from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { protectedProcedure, router } from '../trpc.js'
import { GitHubError, githubService } from '../../github/service.js'

function toTrpcError(err: unknown): TRPCError {
  if (err instanceof GitHubError) {
    const code: TRPCError['code'] =
      err.code === 'not_connected' || err.code === 'not_installed'
        ? 'PRECONDITION_FAILED'
        : 'INTERNAL_SERVER_ERROR'
    return new TRPCError({ code, message: err.message, cause: err })
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: (err as { message?: string })?.message ?? 'github error',
  })
}

/** Per-process CSRF store for the App-manifest flow. Short-lived. */
const csrfStore = new Map<string, { org: string | null; expiresAt: number }>()
const CSRF_TTL_MS = 15 * 60 * 1000

function mintCsrf(org: string | null): string {
  // Purge expired tokens as we go.
  const now = Date.now()
  for (const [k, v] of csrfStore) if (v.expiresAt < now) csrfStore.delete(k)
  const token = crypto.randomBytes(18).toString('base64url')
  csrfStore.set(token, { org, expiresAt: now + CSRF_TTL_MS })
  return token
}

export function consumeCsrf(token: string): { org: string | null } | null {
  const entry = csrfStore.get(token)
  if (!entry) return null
  csrfStore.delete(token)
  if (entry.expiresAt < Date.now()) return null
  return { org: entry.org }
}

export const githubRouter = router({
  status: protectedProcedure.query(async () => githubService.status()),

  /**
   * Return the URL the browser should navigate to start the GitHub App
   * manifest flow. Our /api/github/connect endpoint renders an auto-submitting
   * form that POSTs the manifest to github.com with the CSRF state.
   */
  connectStart: protectedProcedure
    .input(z.object({ org: z.string().min(1).max(39).optional() }))
    .mutation(({ input }) => {
      const state = mintCsrf(input.org ?? null)
      const url = `/api/github/connect?state=${encodeURIComponent(state)}${
        input.org ? `&org=${encodeURIComponent(input.org)}` : ''
      }`
      return { redirectUrl: url }
    }),

  disconnect: protectedProcedure.mutation(async () => {
    await githubService.disconnect()
    return { ok: true as const }
  }),

  listOrgRepos: protectedProcedure.query(async () => {
    try {
      return await githubService.listOrgRepos()
    } catch (err) {
      throw toTrpcError(err)
    }
  }),
})
