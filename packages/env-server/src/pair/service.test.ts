import { beforeEach, describe, expect, it, vi } from 'vitest'

type MetaRow = { id: number; envTokenHash: string | null; pairedAt: string | null }
type PairRow = { sessionId: string; code: string; createdAt: string; expiresAt: string }
type TokenRow = { id: string; tokenHash: string; createdAt: string }

const meta: MetaRow = { id: 1, envTokenHash: null, pairedAt: null }
const pairs: PairRow[] = []
const tokens: TokenRow[] = []

function resetState() {
  meta.envTokenHash = null
  meta.pairedAt = null
  pairs.length = 0
  tokens.length = 0
}

vi.mock('../config.js', () => ({
  config: { CC_KIND: 'local', CC_STATE_DIR: '/tmp/cc-env-state' },
}))

vi.mock('drizzle-orm', () => ({
  eq:
    (col: { _col: string }, val: unknown) =>
    (r: Record<string, unknown>) =>
      r[col._col] === val,
  lt:
    (col: { _col: string }, val: string) =>
    (r: Record<string, unknown>) =>
      String(r[col._col]) < val,
}))

vi.mock('../db/schema.js', () => ({
  envMeta: {
    _table: 'env_meta',
    id: { _col: 'id' },
    envTokenHash: { _col: 'envTokenHash' },
    pairedAt: { _col: 'pairedAt' },
  },
  pairSessions: {
    _table: 'pair_sessions',
    sessionId: { _col: 'sessionId' },
    expiresAt: { _col: 'expiresAt' },
  },
  envTokens: {
    _table: 'env_tokens',
    id: { _col: 'id' },
    tokenHash: { _col: 'tokenHash' },
  },
}))

function tableRows(table: { _table: string }) {
  if (table._table === 'env_meta') return [meta]
  if (table._table === 'pair_sessions') return pairs
  return tokens
}

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({
      from: (table: { _table: string }) => ({
        where: (pred: (r: Record<string, unknown>) => boolean) => ({
          all: () => tableRows(table).filter((r) => pred(r as unknown as Record<string, unknown>)),
        }),
      }),
    }),
    insert: (table: { _table: string }) => ({
      values: (value: Record<string, unknown>) => ({
        run: () => {
          if (table._table === 'pair_sessions') pairs.push(value as PairRow)
          else if (table._table === 'env_tokens') tokens.push(value as TokenRow)
        },
        onConflictDoNothing: () => ({
          run: () => {
            if (table._table === 'env_tokens') tokens.push(value as TokenRow)
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Partial<MetaRow>) => ({
        where: () => ({ run: () => Object.assign(meta, values) }),
      }),
    }),
    delete: (table: { _table: string }) => ({
      where: (pred: (r: Record<string, unknown>) => boolean) => ({
        run: () => {
          if (table._table !== 'pair_sessions') return
          for (let i = pairs.length - 1; i >= 0; i--) {
            if (pred(pairs[i] as unknown as Record<string, unknown>)) pairs.splice(i, 1)
          }
        },
      }),
      run: () => {
        if (table._table === 'pair_sessions') pairs.length = 0
      },
    }),
  },
}))

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

beforeEach(() => {
  resetState()
  vi.resetModules()
})

describe('pair service', () => {
  it('allows local env to mint an additional token when already paired', async () => {
    const { hashEnvToken, setEnvTokenHash, hasEnvTokenHash } = await import('../envmeta/service.js')
    const { pairConfirm, pairStart } = await import('./service.js')

    setEnvTokenHash(hashEnvToken('first-token'))
    const start = pairStart()
    const code = pairs.find((pair) => pair.sessionId === start.sessionId)!.code
    const { envToken } = pairConfirm(start.sessionId, code)

    expect(envToken).toBeTruthy()
    expect(tokens).toHaveLength(1)
    expect(hasEnvTokenHash(hashEnvToken('first-token'))).toBe(true)
    expect(hasEnvTokenHash(hashEnvToken(envToken))).toBe(true)
  })
})
