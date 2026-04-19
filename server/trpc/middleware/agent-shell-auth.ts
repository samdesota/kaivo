import { TRPCError, initTRPC } from '@trpc/server'
import type { Context } from '../context.js'
import { verifyAgentShellToken } from '../../agent/token.js'

const t = initTRPC.context<Context>().create()

function extractBearerToken(ctx: Context): string | null {
  const h = ctx.req?.headers?.authorization
  if (typeof h !== 'string') return null
  const m = /^bearer\s+(\S+)$/i.exec(h)
  return m && m[1] ? m[1] : null
}

/**
 * Auth middleware for `agentShell.*` procedures. Accepts **either**:
 *  - a valid admin session cookie (for UI-driven calls from the app), or
 *  - `Authorization: Bearer <token>` whose sha256 hash matches an active row
 *    in `agent_shell_tokens`.
 *
 * Attaches `ctx.agentSandboxId` so procedure handlers know which sandbox
 * the caller is authorized for.
 *
 * Scope check: for bearer-token calls, `ctx.agentSandboxId` is the sandbox
 * the token was minted for; any input `sandboxId` that mismatches must be
 * rejected by the procedure body.
 */
export const agentShellProcedure = t.procedure.use(async ({ ctx, next }) => {
  const bearer = extractBearerToken(ctx)
  if (bearer) {
    const row = await verifyAgentShellToken(bearer)
    if (!row) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'invalid or revoked agent shell token',
      })
    }
    return next({
      ctx: {
        ...ctx,
        agentSandboxId: row.sandboxId as string,
        agentAuthKind: 'token' as const,
      },
    })
  }
  if (ctx.session) {
    return next({
      ctx: {
        ...ctx,
        agentSandboxId: null as string | null,
        agentAuthKind: 'cookie' as const,
      },
    })
  }
  throw new TRPCError({
    code: 'UNAUTHORIZED',
    message: 'agent shell requires bearer token or admin cookie',
  })
})

/**
 * Resolve the sandbox id the caller is authorized for, given the input's
 * `sandboxId`. Cookie callers must supply `sandboxId` in the input; token
 * callers must match the token's bound sandbox (an explicit `sandboxId` in
 * the input is permitted but must match).
 */
export function resolveAgentSandboxId(
  ctx: { agentSandboxId: string | null; agentAuthKind: 'token' | 'cookie' },
  inputSandboxId: string | null | undefined,
): string {
  if (ctx.agentAuthKind === 'token') {
    if (!ctx.agentSandboxId) {
      throw new TRPCError({ code: 'UNAUTHORIZED' })
    }
    if (inputSandboxId && inputSandboxId !== ctx.agentSandboxId) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'token is scoped to a different sandbox',
      })
    }
    return ctx.agentSandboxId
  }
  if (!inputSandboxId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'sandboxId required for cookie-authenticated agentShell calls',
    })
  }
  return inputSandboxId
}
