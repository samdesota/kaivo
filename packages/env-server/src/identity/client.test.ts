import { afterEach, describe, expect, it, vi } from 'vitest'

const requestMock = vi.hoisted(() => vi.fn())

vi.mock('undici', () => ({
  request: requestMock,
}))

describe('identity client', () => {
  afterEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    requestMock.mockReset()
  })

  it('encodes openPane as an authenticated envApi mutation', async () => {
    vi.stubEnv('CC_WORKING_DIR', '/tmp/workspace')
    vi.stubEnv('CC_IDENTITY_URL', 'http://identity.test')
    vi.stubEnv('CC_STATE_DIR', '/tmp/state')
    requestMock.mockResolvedValue({
      statusCode: 200,
      body: { json: async () => ({ result: { data: { json: { ok: true, tab: { id: 'tab-1' } } } } }) },
    })

    const { openPane, setIdentityToken } = await import('./client.js')
    setIdentityToken('identity-token')

    await expect(openPane({
      workspaceId: 'workspace-1',
      envId: 'local-default',
      content: { type: 'file', path: '/tmp/a.ts' },
      title: 'a.ts',
      activate: false,
    })).resolves.toEqual({ ok: true, tab: { id: 'tab-1' } })

    expect(requestMock).toHaveBeenCalledWith('http://identity.test/trpc/envApi.openPane', {
      method: 'POST',
      headers: {
        authorization: 'Bearer identity-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        json: {
          workspaceId: 'workspace-1',
          envId: 'local-default',
          content: { type: 'file', path: '/tmp/a.ts' },
          title: 'a.ts',
          activate: false,
        },
      }),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    })
  })
})
