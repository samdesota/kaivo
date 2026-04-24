import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type TokenRow = {
  tokenHash: string
  label: string
  source: 'service' | 'device'
  issuedAt: Date
  revokedAt: Date | null
}
type DeviceRow = {
  deviceCode: string
  userCode: string
  label: string
  status: 'pending' | 'approved' | 'denied' | 'expired'
  grantedTokenHash: string | null
  expiresAt: Date
  createdAt: Date
  approvedAt: Date | null
}

const tokenRows: TokenRow[] = []
const deviceRows: DeviceRow[] = []

function reset() {
  tokenRows.length = 0
  deviceRows.length = 0
}

vi.mock('drizzle-orm', () => ({
  and:
    (...preds: Array<(r: Record<string, unknown>) => boolean>) =>
    (r: Record<string, unknown>) =>
      preds.every((p) => p(r)),
  eq:
    (col: { _col: string }, val: unknown) =>
    (r: Record<string, unknown>) =>
      r[col._col] === val,
  lt:
    (col: { _col: string }, val: Date) =>
    (r: Record<string, unknown>) =>
      (r[col._col] as Date).getTime() < val.getTime(),
}))

vi.mock('../db/schema.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    envAuthTokens: {
      _table: 'env_auth_tokens',
      tokenHash: { _col: 'tokenHash' },
      label: { _col: 'label' },
      source: { _col: 'source' },
      issuedAt: { _col: 'issuedAt' },
      revokedAt: { _col: 'revokedAt' },
    },
    envAuthDeviceRequests: {
      _table: 'env_auth_device_requests',
      deviceCode: { _col: 'deviceCode' },
      userCode: { _col: 'userCode' },
      label: { _col: 'label' },
      status: { _col: 'status' },
      grantedTokenHash: { _col: 'grantedTokenHash' },
      expiresAt: { _col: 'expiresAt' },
      createdAt: { _col: 'createdAt' },
      approvedAt: { _col: 'approvedAt' },
    },
  }
})

vi.mock('../db/client.js', () => {
  return {
    db: {
      insert: (table: { _table: string }) => ({
        values: async (v: Record<string, unknown>) => {
          if (table._table === 'env_auth_tokens') {
            tokenRows.push({
              tokenHash: v.tokenHash as string,
              label: v.label as string,
              source: v.source as 'service' | 'device',
              issuedAt: new Date(),
              revokedAt: null,
            })
          } else if (table._table === 'env_auth_device_requests') {
            deviceRows.push({
              deviceCode: v.deviceCode as string,
              userCode: v.userCode as string,
              label: v.label as string,
              status: 'pending',
              grantedTokenHash: null,
              expiresAt: v.expiresAt as Date,
              createdAt: new Date(),
              approvedAt: null,
            })
          }
        },
      }),
      select: (_cols?: unknown) => ({
        from: (table: { _table: string }) => ({
          where: (pred: (r: Record<string, unknown>) => boolean) => ({
            limit: async (_n: number) => {
              const rows =
                table._table === 'env_auth_tokens' ? tokenRows : deviceRows
              return (rows as unknown as Record<string, unknown>[]).filter(pred)
            },
          }),
        }),
      }),
      update: (table: { _table: string }) => ({
        set: (vals: Record<string, unknown>) => ({
          where: async (pred: (r: Record<string, unknown>) => boolean) => {
            const rows =
              table._table === 'env_auth_tokens' ? tokenRows : deviceRows
            let count = 0
            for (const r of rows as unknown as Record<string, unknown>[]) {
              if (pred(r)) {
                Object.assign(r, vals)
                count++
              }
            }
            return { rowCount: count }
          },
        }),
      }),
    },
  }
})

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

let svc: typeof import('./service.js')

beforeEach(async () => {
  reset()
  svc = await import('./service.js')
})
afterEach(() => {
  vi.resetModules()
})

describe('envauth service', () => {
  it('mints + resolves service tokens', async () => {
    const { token } = await svc.issueEnvAuthToken('container:abc', 'service')
    const resolved = await svc.resolveEnvAuthToken(token)
    expect(resolved).not.toBeNull()
    expect(resolved?.label).toBe('container:abc')
    expect(resolved?.source).toBe('service')
  })

  it('rejects unknown / too-short tokens', async () => {
    expect(await svc.resolveEnvAuthToken('nope')).toBeNull()
    expect(await svc.resolveEnvAuthToken('x'.repeat(40))).toBeNull()
  })

  it('rejects revoked tokens', async () => {
    const { token, tokenHash } = await svc.issueEnvAuthToken('gone', 'service')
    expect(await svc.resolveEnvAuthToken(token)).not.toBeNull()
    // Revoke
    const now = new Date()
    tokenRows[0]!.revokedAt = now
    expect(await svc.resolveEnvAuthToken(token)).toBeNull()
    // tokenHash is returned so callers can revoke by PK
    expect(tokenHash).toBe(tokenRows[0]!.tokenHash)
  })

  it('device flow: start → confirm → poll returns token once', async () => {
    const start = await svc.deviceStart('my-laptop', 'https://cc.example.com')
    expect(start.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(start.expiresIn).toBe(600)

    // Before confirm
    let poll = await svc.devicePoll(start.deviceCode)
    expect(poll.status).toBe('pending')

    await svc.deviceConfirm(start.userCode)

    poll = await svc.devicePoll(start.deviceCode)
    expect(poll.status).toBe('approved')
    if (poll.status === 'approved') {
      // Token is valid
      const resolved = await svc.resolveEnvAuthToken(poll.identityToken)
      expect(resolved?.label).toBe('my-laptop')
      expect(resolved?.source).toBe('device')
    }

    // Second poll: raw token already consumed → reported as expired
    const second = await svc.devicePoll(start.deviceCode)
    expect(second.status).toBe('expired')
  })

  it('device flow: unknown code → not_found on confirm', async () => {
    await expect(svc.deviceConfirm('NOPE-CODE')).rejects.toMatchObject({
      kind: 'not_found',
    })
  })

  it('device flow: expired pending request auto-expires on poll', async () => {
    const start = await svc.deviceStart('expire-me', 'https://x')
    // Force-expire the row
    deviceRows[0]!.expiresAt = new Date(Date.now() - 1000)
    const poll = await svc.devicePoll(start.deviceCode)
    expect(poll.status).toBe('expired')
    // Row was updated
    expect(deviceRows[0]!.status).toBe('expired')
  })

  it('device flow: confirming expired request throws expired', async () => {
    const start = await svc.deviceStart('expire-me', 'https://x')
    deviceRows[0]!.expiresAt = new Date(Date.now() - 1000)
    await expect(svc.deviceConfirm(start.userCode)).rejects.toMatchObject({
      kind: 'expired',
    })
  })

  it('device flow: double-confirming throws already_resolved', async () => {
    const start = await svc.deviceStart('double', 'https://x')
    await svc.deviceConfirm(start.userCode)
    await expect(svc.deviceConfirm(start.userCode)).rejects.toMatchObject({
      kind: 'already_resolved',
    })
  })

  it('verification URL points at /envauth/device with the user code', async () => {
    const start = await svc.deviceStart('u', 'https://cc.example.com/')
    expect(start.verificationUrl).toBe(
      `https://cc.example.com/envauth/device?code=${encodeURIComponent(start.userCode)}`,
    )
  })
})
