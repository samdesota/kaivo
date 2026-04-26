import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../../src/lib/env-tokens', () => ({
  getEnvToken: (id: string) => (id === 'container-1' ? 'stored-container-token' : null),
}))

vi.mock('../../src/lib/env-client', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../src/lib/env-client')
  return {
    ...actual,
    makeEnvClient: (env: { id: string; kind: string; url: string }, token: string) => ({ env, token }),
  }
})

import {
  createWorkspaceEnvClientResolver,
  resolveWorkspaceEnvTarget,
  selectLocalEnvTarget,
  unavailableReasonForWorkspaceTab,
  type WorkspaceEnvRow,
} from '../../src/routes/workspace/env-targets'
import { resolveEnvUrl } from '../../src/lib/env-client'

function env(row: Partial<WorkspaceEnvRow> & Pick<WorkspaceEnvRow, 'id' | 'kind' | 'url'>): WorkspaceEnvRow {
  return {
    label: row.id,
    envToken: null,
    localIdentityLabel: null,
    status: 'running',
    ...row,
  }
}

describe('workspace env targets', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      value: { location: { origin: 'https://code.example.test', protocol: 'https:', host: 'code.example.test' } },
      configurable: true,
    })
    Object.defineProperty(globalThis.window, 'location', {
      value: { origin: 'https://code.example.test' },
      writable: true,
    })
  })

  it('target resolver distinguishes local and remote env URL/token shapes', () => {
    const local = resolveWorkspaceEnvTarget(
      env({ id: 'local-1', kind: 'local', url: 'http://127.0.0.1:47821', envToken: 'local-token' }),
    )
    const remote = resolveWorkspaceEnvTarget(
      env({ id: 'container-1', kind: 'container', url: '/env/container-1' }),
    )

    expect(local.token).toBe('local-token')
    expect(remote.token).toBe('stored-container-token')
    expect(resolveEnvUrl(local.env)).toBe('http://127.0.0.1:47821')
    expect(resolveEnvUrl(remote.env)).toBe('https://code.example.test/env/container-1')
  })

  it('workspace bootstrap can resolve clients by envId without one route-level env', () => {
    const targets = [
      resolveWorkspaceEnvTarget(env({ id: 'local-1', kind: 'local', url: 'http://127.0.0.1:47821', envToken: 'local-token' })),
      resolveWorkspaceEnvTarget(env({ id: 'container-1', kind: 'container', url: '/env/container-1' })),
      resolveWorkspaceEnvTarget(env({ id: 'dead-1', kind: 'container', url: '/env/dead-1', status: 'unreachable' })),
    ]

    const localTarget = selectLocalEnvTarget(targets)
    const getEnvClient = createWorkspaceEnvClientResolver(targets)

    expect(localTarget?.env.id).toBe('local-1')
    expect(getEnvClient('container-1')).toMatchObject({ token: 'stored-container-token' })
    expect(() => getEnvClient('dead-1')).toThrow(/unreachable/)
  })

  it('unavailable env target renders as per-tab state instead of failing workspace', () => {
    const targets = [
      resolveWorkspaceEnvTarget(env({ id: 'local-1', kind: 'local', url: 'http://127.0.0.1:47821', envToken: 'local-token' })),
      resolveWorkspaceEnvTarget(env({ id: 'dead-1', kind: 'container', url: '/env/dead-1', status: 'unreachable' })),
    ]

    expect(
      unavailableReasonForWorkspaceTab(
        { id: 'tab-1', type: 'preview', envId: 'dead-1', port: 3000, title: ':3000' },
        targets,
      ),
    ).toMatch(/unreachable/)
    expect(
      unavailableReasonForWorkspaceTab(
        { id: 'tab-2', type: 'preview', envId: 'local-1', port: 3000, title: ':3000' },
        targets,
      ),
    ).toBeNull()
  })
})
