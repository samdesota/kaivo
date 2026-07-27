import crypto from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import { db } from '../db/client.js'
import { agentSessionCredentials, agentSessions } from '../db/schema.js'
import type { EnvPrincipal } from './principal.js'

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function createAgentSessionCredential(sessionId: string): string {
  const session = db.select().from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1).all()[0]
  if (!session) throw new Error('agent session not found')
  const token = crypto.randomBytes(32).toString('hex')
  db.insert(agentSessionCredentials).values({
    id: ulid().toLowerCase(),
    sessionId,
    tokenHash: tokenHash(token),
    createdAt: new Date().toISOString(),
    revokedAt: null,
  }).run()
  return token
}

export function createAgentSessionCredentialForOpencodeSession(opencodeSessionId: string): {
  token: string
  principal: Extract<EnvPrincipal, { kind: 'agent' }>
} {
  const session = db.select().from(agentSessions)
    .where(eq(agentSessions.opencodeSessionId, opencodeSessionId)).limit(1).all()[0]
  if (!session) throw new Error('agent session not found')
  const token = createAgentSessionCredential(session.id)
  return {
    token,
    principal: {
      kind: 'agent',
      agentSessionId: session.id,
      opencodeSessionId: session.opencodeSessionId,
      workspaceId: session.workspaceId ?? null,
      sessionKind: session.kind,
    },
  }
}

export function resolveAgentSessionPrincipal(token: string): EnvPrincipal | null {
  const credential = db
    .select({ sessionId: agentSessionCredentials.sessionId })
    .from(agentSessionCredentials)
    .where(and(eq(agentSessionCredentials.tokenHash, tokenHash(token)), isNull(agentSessionCredentials.revokedAt)))
    .limit(1)
    .all()[0]
  if (!credential) return null
  const session = db.select().from(agentSessions).where(eq(agentSessions.id, credential.sessionId)).limit(1).all()[0]
  if (!session) return null
  return {
    kind: 'agent',
    agentSessionId: session.id,
    opencodeSessionId: session.opencodeSessionId,
    workspaceId: session.workspaceId ?? null,
    sessionKind: session.kind,
  }
}
