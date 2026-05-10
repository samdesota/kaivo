import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Focused tests on the `startOpenCode` bootstrap path introduced in Phase 4:
 * a fresh agent-shell token gets minted, config.json is written with the
 * plugin entry, and `docker exec` is invoked with CLOUDCODE_AGENT_TOKEN +
 * CLOUDCODE_APP_URL set.
 */

interface ExecInvocation {
  args: string[]
  env: Record<string, string>
  stdin?: string
}
const execCalls: ExecInvocation[] = []
const tokenRows: Array<{ tokenHash: string; sandboxId: string; revokedAt: Date | null }> = []

let tmpRoot: string

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
  desc: () => ({}),
  sql: () => ({}),
}))

vi.mock('../db/schema.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    agentShellTokens: {
      tokenHash: { _col: 'tokenHash' },
      sandboxId: { _col: 'sandboxId' },
      issuedAt: { _col: 'issuedAt' },
      revokedAt: { _col: 'revokedAt' },
    },
    sandboxes: {
      id: { _col: 'id' },
      opencodePort: { _col: 'opencodePort' },
      opencodePasswordSecret: { _col: 'opencodePasswordSecret' },
    },
    repos: { sandboxId: { _col: 'sandboxId' } },
  }
})

const sandboxRow = {
  id: 'sb-a',
  name: 'sb',
  containerId: 'container-fake',
  status: 'active' as const,
  opencodePort: 4096,
  opencodePasswordSecret: null as string | null,
  archivedAt: null,
  createdAt: new Date(),
}

vi.mock('../db/client.js', () => ({
  db: {
    insert: (_t: unknown) => ({
      values: async (v: Record<string, unknown>) => {
        if ('tokenHash' in v) {
          tokenRows.push({
            tokenHash: v.tokenHash as string,
            sandboxId: v.sandboxId as string,
            revokedAt: null,
          })
        }
      },
    }),
    select: (_c?: unknown) => ({
      from: (_t: unknown) => ({
        where: (pred: (r: Record<string, unknown>) => boolean) => {
          const resolve = () => {
            const isToken = matchesTokenPred(pred)
            if (isToken) return tokenRows.filter((r) => pred(r as unknown as Record<string, unknown>))
            if (pred(sandboxRow as unknown as Record<string, unknown>)) return [sandboxRow]
            return []
          }
          return {
            limit: async (_n: number) => resolve(),
            then: (onF: (v: unknown) => void) => Promise.resolve(resolve()).then(onF),
          }
        },
      }),
    }),
    update: (_t: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: async (pred: (r: Record<string, unknown>) => boolean) => {
          for (const r of tokenRows) if (pred(r as unknown as Record<string, unknown>)) Object.assign(r, vals)
        },
      }),
    }),
    delete: () => ({ where: async () => undefined }),
  },
}))

function matchesTokenPred(pred: unknown): boolean {
  try {
    ;(pred as (r: Record<string, unknown>) => boolean)({
      tokenHash: '',
      sandboxId: '',
      revokedAt: null,
    })
    return true
  } catch {
    return false
  }
}

vi.mock('../sandbox/manager.js', () => ({
  sandboxManager: {
    get: async () => ({
      id: 'sb-a',
      name: 'sb',
      status: 'active' as const,
      containerId: 'container-fake',
      createdAt: new Date(),
      archivedAt: null,
      running: true,
      workspacePath: '/tmp',
    }),
    onEvent: () => () => {},
  },
}))

vi.mock('../secrets/index.js', () => ({
  getSecret: async () => 'fake-password',
  putSecret: async () => undefined,
}))

vi.mock('../preview/service.js', () => ({
  previewService: { getContainerIp: async () => '10.0.0.2' },
}))

vi.mock('./providers.js', () => ({
  buildProviderEnv: async () => ({ ANTHROPIC_API_KEY: 'test-key' }),
  anyProviderConfigured: async () => true,
}))

// Stub child_process.spawn: record docker exec invocations.
vi.mock('node:child_process', async () => {
  const actual = (await vi.importActual(
    'node:child_process',
  )) as typeof import('node:child_process')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events')
  return {
    ...actual,
    spawn: (_cmd: string, args: string[]) => {
      const invocation: ExecInvocation = { args: [...args], env: {} }
      // Parse -e KEY=VAL pairs out of args for easy assertion.
      for (let i = 0; i < args.length - 1; i++) {
        if (args[i] === '-e' && args[i + 1]) {
          const kv = args[i + 1]!
          const eq = kv.indexOf('=')
          if (eq > 0) invocation.env[kv.slice(0, eq)] = kv.slice(eq + 1)
        }
      }
      execCalls.push(invocation)
      const child = new EE() as InstanceType<typeof EE> & {
        stdout: InstanceType<typeof EE>
        stderr: InstanceType<typeof EE>
        stdin: { write: (s: string) => void; end: () => void }
        kill: () => void
      }
      child.stdout = new EE()
      child.stderr = new EE()
      const stdinBufs: string[] = []
      child.stdin = {
        write: (s: string) => stdinBufs.push(s),
        end: () => {
          invocation.stdin = stdinBufs.join('')
          queueMicrotask(() => child.emit('exit', 0, null))
        },
      }
      child.kill = () => child.emit('exit', null, 'SIGKILL')
      // If nothing writes to stdin (the non-config path), still exit.
      queueMicrotask(() => {
        if (!invocation.stdin) child.emit('exit', 0, null)
      })
      return child
    },
  }
})

// Stub undici request: probeReady returns 200 so startOpenCode exits early.
vi.mock('undici', () => ({
  request: async () => ({
    statusCode: 200,
    body: { dump: async () => undefined },
  }),
}))

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-boot-'))
  process.env.DATA_DIR = tmpRoot
  process.env.SANDBOX_APP_URL = 'http://app:3000'
  execCalls.length = 0
  tokenRows.length = 0
  // Ensure the sandbox opencode dir exists for config write.
  await fs.mkdir(path.join(tmpRoot, 'sandboxes', 'sb-a', 'opencode'), { recursive: true })
  vi.resetModules()
})
afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('startOpenCode — agent-shell token + plugin config injection', () => {
  it('short-circuits when opencode is already up (probe returns 2xx)', async () => {
    // First call to probeReady returns 200 → early return with no exec or mint.
    const { startOpenCode } = await import('./opencode.js')
    const ep = await startOpenCode('sb-a')
    expect(ep.port).toBe(4096)
    // When already running, we neither mint a token nor fork docker exec.
    expect(tokenRows).toHaveLength(0)
    expect(execCalls).toHaveLength(0)
  })

  it('mints a token, writes plugin config, and injects env on a cold start', async () => {
    // Return 503 on the first couple probes (cold) then 200, so the cold-start
    // path runs. We achieve this by replacing undici between imports.
    let probes = 0
    vi.doMock('undici', () => ({
      request: async () => {
        probes += 1
        return {
          statusCode: probes <= 1 ? 503 : 200,
          body: { dump: async () => undefined },
        }
      },
    }))
    const { startOpenCode } = await import('./opencode.js')

    await startOpenCode('sb-a')

    // A fresh token row exists, hash-only.
    expect(tokenRows).toHaveLength(1)
    expect(tokenRows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenRows[0]!.sandboxId).toBe('sb-a')

    // The final docker exec (the one that launched opencode) had our env.
    const launch = execCalls.find((c) => c.env.CLOUDCODE_AGENT_TOKEN)
    expect(launch).toBeDefined()
    expect(launch!.env.CLOUDCODE_APP_URL).toBe('http://app:3000')
    expect(launch!.env.CLOUDCODE_AGENT_TOKEN).toMatch(/^[0-9a-f]{64}$/)
    expect(launch!.env.OPENCODE_SERVER_PASSWORD).toBe('fake-password')

    // Plugin config is written via `docker exec ... cat > ...` — the
    // cold-start path should produce exactly one such invocation with the
    // JSON on stdin and the target config path in the bash command.
    const configExec = execCalls.find(
      (c) => c.args.join(' ').includes('opencode.json') && typeof c.stdin === 'string',
    )
    expect(configExec).toBeDefined()
    expect(configExec!.args.join(' ')).toContain(
      '/home/coder/.config/opencode/opencode.json',
    )
    const cfg = JSON.parse(configExec!.stdin!) as { plugin: unknown[] }
    expect(cfg.plugin).toContain('file:///opt/cloud-code-plugin/index.js')
  })

  it('revokes prior tokens on restart (rotation)', async () => {
    // Seed an existing token row we expect to get revoked.
    tokenRows.push({
      tokenHash: 'a'.repeat(64),
      sandboxId: 'sb-a',
      revokedAt: null,
    })

    let probes = 0
    vi.doMock('undici', () => ({
      request: async () => ({
        statusCode: probes++ === 0 ? 503 : 200,
        body: { dump: async () => undefined },
      }),
    }))
    const { startOpenCode } = await import('./opencode.js')
    await startOpenCode('sb-a')

    // The prior row is now revoked; a new (unrevoked) row was inserted.
    const prior = tokenRows.find((r) => r.tokenHash === 'a'.repeat(64))!
    expect(prior.revokedAt).not.toBeNull()
    const active = tokenRows.filter((r) => r.revokedAt === null)
    expect(active).toHaveLength(1)
  })
})
