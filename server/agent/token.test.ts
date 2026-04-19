import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests for the agent-shell token module. Stubs `db` with an
 * in-memory table so the tests don't need Postgres.
 */

interface TokenRow {
  tokenHash: string
  sandboxId: string
  issuedAt: Date
  revokedAt: Date | null
}

function makeDbStub() {
  const rows: TokenRow[] = []

  function whereMatch(conds: Array<(r: TokenRow) => boolean>) {
    return (r: TokenRow) => conds.every((c) => c(r))
  }

  return {
    rows,
    db: {
      insert: () => ({
        values: async (v: Partial<TokenRow>) => {
          rows.push({
            tokenHash: v.tokenHash!,
            sandboxId: v.sandboxId!,
            issuedAt: new Date(),
            revokedAt: null,
          })
        },
      }),
      select: () => ({
        from: () => ({
          where: (pred: (r: TokenRow) => boolean) => ({
            limit: async () => rows.filter(pred),
          }),
        }),
      }),
      update: () => ({
        set: (vals: Partial<TokenRow>) => ({
          where: async (pred: (r: TokenRow) => boolean) => {
            for (const r of rows) if (pred(r)) Object.assign(r, vals)
          },
        }),
      }),
    },
    whereMatch,
  }
}

// drizzle's `and`/`eq`/`isNull` need to compose into a predicate our stub can
// evaluate. We replace the drizzle module with a tiny functional shim.
vi.mock('drizzle-orm', () => ({
  and:
    (...preds: Array<(r: Record<string, unknown>) => boolean>) =>
    (r: Record<string, unknown>) =>
      preds.every((p) => p(r)),
  eq:
    (col: { _col: string }, val: unknown) =>
    (r: Record<string, unknown>) =>
      r[col._col] === val,
  isNull:
    (col: { _col: string }) =>
    (r: Record<string, unknown>) =>
      r[col._col] === null || r[col._col] === undefined,
}))

vi.mock('../db/schema.js', () => ({
  agentShellTokens: {
    tokenHash: { _col: 'tokenHash' },
    sandboxId: { _col: 'sandboxId' },
    issuedAt: { _col: 'issuedAt' },
    revokedAt: { _col: 'revokedAt' },
  },
}))

describe('agent-shell tokens', () => {
  let stub: ReturnType<typeof makeDbStub>

  beforeEach(() => {
    vi.resetModules()
    stub = makeDbStub()
    vi.doMock('../db/client.js', () => ({ db: stub.db }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('mints a token and persists only the sha256 hash', async () => {
    const { mintAgentShellToken, __tokenInternals } = await import('./token.js')
    const { token, tokenHash } = await mintAgentShellToken('sb-a')
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenHash).toBe(__tokenInternals.hashToken(token))
    // Persisted row contains the hash, not the plaintext.
    expect(stub.rows).toHaveLength(1)
    expect(stub.rows[0]!.tokenHash).toBe(tokenHash)
    expect(stub.rows[0]!.sandboxId).toBe('sb-a')
    expect(stub.rows.find((r) => r.tokenHash === token)).toBeUndefined()
  })

  it('verifies a minted token and resolves its sandbox', async () => {
    const { mintAgentShellToken, verifyAgentShellToken } = await import('./token.js')
    const { token } = await mintAgentShellToken('sb-a')
    const result = await verifyAgentShellToken(token)
    expect(result).toEqual({ sandboxId: 'sb-a' })
  })

  it('returns null for an unknown token', async () => {
    const { verifyAgentShellToken } = await import('./token.js')
    expect(await verifyAgentShellToken('not-a-real-token')).toBeNull()
    expect(await verifyAgentShellToken('')).toBeNull()
  })

  it('rejects revoked tokens', async () => {
    const { mintAgentShellToken, revokeAgentShellToken, verifyAgentShellToken } =
      await import('./token.js')
    const { token } = await mintAgentShellToken('sb-a')
    await revokeAgentShellToken(token)
    expect(await verifyAgentShellToken(token)).toBeNull()
  })

  it('revokeAgentShellTokensForSandbox revokes only that sandbox\'s tokens', async () => {
    const {
      mintAgentShellToken,
      revokeAgentShellTokensForSandbox,
      verifyAgentShellToken,
    } = await import('./token.js')
    const a = await mintAgentShellToken('sb-a')
    const b = await mintAgentShellToken('sb-b')
    await revokeAgentShellTokensForSandbox('sb-a')
    expect(await verifyAgentShellToken(a.token)).toBeNull()
    expect(await verifyAgentShellToken(b.token)).toEqual({ sandboxId: 'sb-b' })
  })
})
