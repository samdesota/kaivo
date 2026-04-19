import { createHash, randomBytes } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agentShellTokens } from '../db/schema.js'

const TOKEN_BYTES = 32 // 256 bits → 64 hex chars

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Mint a fresh bearer token for the given sandbox. Returns the plaintext
 * token (caller hands this to the plugin) and the hash row that was
 * persisted. Only the hash is stored.
 */
export async function mintAgentShellToken(sandboxId: string): Promise<{
  token: string
  tokenHash: string
}> {
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  const tokenHash = hashToken(token)
  await db.insert(agentShellTokens).values({
    tokenHash,
    sandboxId,
  })
  return { token, tokenHash }
}

/**
 * Verify a plaintext bearer token against active rows in
 * `agent_shell_tokens`. Returns the sandbox id if valid and not revoked,
 * otherwise null.
 */
export async function verifyAgentShellToken(token: string): Promise<{
  sandboxId: string
} | null> {
  if (!token || typeof token !== 'string') return null
  const tokenHash = hashToken(token)
  const rows = await db
    .select()
    .from(agentShellTokens)
    .where(
      and(
        eq(agentShellTokens.tokenHash, tokenHash),
        isNull(agentShellTokens.revokedAt),
      ),
    )
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return { sandboxId: row.sandboxId }
}

/** Revoke all active tokens for a sandbox. Called on sandbox restart/archive. */
export async function revokeAgentShellTokensForSandbox(sandboxId: string): Promise<void> {
  await db
    .update(agentShellTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(agentShellTokens.sandboxId, sandboxId),
        isNull(agentShellTokens.revokedAt),
      ),
    )
}

/** Revoke a specific token by plaintext. */
export async function revokeAgentShellToken(token: string): Promise<void> {
  const tokenHash = hashToken(token)
  await db
    .update(agentShellTokens)
    .set({ revokedAt: new Date() })
    .where(eq(agentShellTokens.tokenHash, tokenHash))
}

/** Exposed for tests. */
export const __tokenInternals = { hashToken }
