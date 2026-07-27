import { TRPCError } from '@trpc/server'
import type { AgentSessionKind } from '../orchestration/contracts.js'

export type EnvPrincipal =
  | { kind: 'user' }
  | {
      kind: 'agent'
      agentSessionId: string
      opencodeSessionId: string
      workspaceId: string | null
      sessionKind: AgentSessionKind
    }

export type EnvCapability =
  | 'orchestration:dispatch'
  | 'orchestration:delivery:own'
  | 'orchestration:read'
  | 'orchestration:complete'

export function hasCapability(principal: EnvPrincipal | null, capability: EnvCapability): boolean {
  if (!principal) return false
  if (principal.kind === 'user') return true
  if (principal.sessionKind === 'dispatch') {
    return capability === 'orchestration:dispatch' || capability === 'orchestration:read'
  }
  if (principal.sessionKind === 'subtask') {
    return capability === 'orchestration:delivery:own' || capability === 'orchestration:read'
  }
  return false
}

export function requireCapability(principal: EnvPrincipal | null, capability: EnvCapability): void {
  if (!hasCapability(principal, capability)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: `missing capability: ${capability}` })
  }
}
