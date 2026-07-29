import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitDiffResult } from '../git/service.js'
import type { WalkthroughModelRunner } from './model-runner.js'

let root = ''
let sqliteRaw: import('better-sqlite3').Database

const PATCH = 'diff --git a/a.txt b/a.txt\nindex 1111111..2222222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n'
const exec = promisify(execFile)

function result(patch = PATCH, truncated = false): GitDiffResult {
  return {
    repository: { root: '/repo', gitDir: '/repo/.git', headOid: 'head-1', branch: 'feature' },
    kind: 'branch',
    baseRef: 'refs/remotes/origin/main',
    mergeBaseOid: 'base-1',
    patch,
    files: [{ oldPath: null, path: 'a.txt', status: 'modified', binary: false, additions: 1, deletions: 1 }],
    additions: 1,
    deletions: 1,
    byteCount: Buffer.byteLength(patch),
    truncated,
    warnings: truncated ? ['truncated'] : [],
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'walkthrough-service-'))
  vi.stubEnv('CC_STATE_DIR', root)
  vi.stubEnv('CC_WORKING_DIR', root)
  vi.stubEnv('CC_IDENTITY_URL', 'http://127.0.0.1:1')
  vi.resetModules()
  const [{ runMigrations }, client] = await Promise.all([import('../db/migrate.js'), import('../db/client.js')])
  sqliteRaw = client.sqliteRaw
  await runMigrations()
})

afterEach(async () => {
  if (sqliteRaw?.open) sqliteRaw.close()
  vi.unstubAllEnvs()
  await fs.rm(root, { recursive: true, force: true })
})

function completeRunner(): WalkthroughModelRunner {
  return {
    async *run(input) {
      const user = input.messages.find((entry) => entry.role === 'user')?.content ?? ''
      const manifest = JSON.parse(user.split('CANONICAL MANIFEST\n')[1]!.split('\n\nRAW UNIFIED DIFF')[0]!) as {
        digest: string
        files: Array<{ index: number; oldPath: string | null; newPath: string | null }>
      }
      yield { type: 'session', sessionId: 'private-session-1' }
      const markdown = ['# Behavior first\n\n', ...manifest.files.slice().reverse().map((file) => {
        const directive = { version: 1, diff: manifest.digest, id: `concept-${file.index}`, file: { index: file.index, oldPath: file.oldPath, newPath: file.newPath }, collapsed: false }
        return `## Concept ${file.index}\n\n\`\`\`kaivo-diff\n${JSON.stringify(directive)}\n\`\`\`\n\n`
      })].join('')
      for (const chunk of [markdown.slice(0, 7), markdown.slice(7, 29), markdown.slice(29)]) {
        yield { type: 'text-delta', delta: chunk }
      }
      yield { type: 'finish' }
    },
  }
}

async function harness(
  snapshot = result(),
  maxPatchBytes?: number,
  runner: WalkthroughModelRunner = completeRunner(),
  maxOutputBytes?: number,
  maxInputBytes?: number,
) {
  const { WalkthroughService } = await import('./service.js')
  const originBranches = vi.fn().mockResolvedValue({
    repository: snapshot.repository,
    branches: [{ name: 'main', ref: 'refs/remotes/origin/main', oid: 'origin-1', isDefault: true }],
    defaultBranch: { name: 'main', ref: 'refs/remotes/origin/main', oid: 'origin-1', isDefault: true },
    defaultSource: 'symbolic-ref',
  })
  const diff = vi.fn().mockResolvedValue(snapshot)
  return {
    service: new WalkthroughService({
      git: { originBranches, diff },
      maxPatchBytes,
      runner,
      resolveModel: () => ({ providerID: 'openai', modelID: 'gpt-test', variant: 'high' }),
      eventChunkBytes: 24,
      eventFlushMs: 5,
      maxOutputBytes,
      maxInputBytes,
    }),
    originBranches,
    diff,
  }
}

async function terminal(service: { snapshot(id: string): { status: string } }, id: string) {
  await vi.waitFor(() => expect(['completed', 'failed', 'cancelled']).toContain(service.snapshot(id).status))
}

describe('walkthrough service', () => {
  it('resolves a fresh default origin, persists an immutable complete snapshot, and emits monotonic events', async () => {
    const h = await harness()
    const started = await h.service.start({
      requestKey: 'request-1', cwd: '/repo/subdir',
      comparison: { kind: 'branch', originBranch: null, includeUncommitted: true },
    })
    await terminal(h.service, started.walkthroughId)
    const snapshot = h.service.snapshot(started.walkthroughId)

    expect(h.originBranches).toHaveBeenCalledWith('/repo/subdir')
    expect(h.diff).toHaveBeenCalledWith({ cwd: '/repo/subdir', kind: 'branch', originBranch: 'main', includeUncommitted: true })
    expect(snapshot).toMatchObject({
      status: 'completed', patch: PATCH, baseRef: 'refs/remotes/origin/main', mergeBaseOid: 'base-1',
      comparison: { kind: 'branch', originBranch: 'main', includeUncommitted: true },
      coverage: { missing: 0 },
    })
    expect(snapshot.coverage.covered).toBe(snapshot.coverage.total)
    expect(snapshot.markdown).toContain('```kaivo-diff')
    const events = h.service.events(snapshot.id, 0)
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index + 1))
    expect(events[0]?.type).toBe('started')
    expect(events.at(-1)?.type).toBe('completed')
    const markdownEvents = events.filter((event) => event.type === 'markdown.appended')
    expect(markdownEvents.length).toBeGreaterThan(1)
    expect(markdownEvents.map((event) => (event.data as { markdown: string }).markdown).join('')).toBe(snapshot.markdown)
    expect(events.filter((event) => event.type === 'status.changed').map((event) => (event.data as { status: string }).status))
      .toEqual(['thinking', 'streaming', 'checking', 'completed'])
    expect(snapshot.runner).toEqual({ providerID: 'openai', modelID: 'gpt-test', variant: 'high', sessionId: 'private-session-1' })

    const mutable = result(PATCH.replace('+new', '+changed-after-start'))
    h.diff.mockResolvedValue(mutable)
    expect(h.service.snapshot(snapshot.id).patch).toBe(PATCH)
  })

  it('uses request keys idempotently while deliberate starts create distinct rows', async () => {
    const h = await harness()
    const input = { requestKey: 'same', cwd: '/repo', comparison: { kind: 'working-tree' as const, branch: { kind: 'branch' as const, originBranch: null, includeUncommitted: true } } }
    const first = await h.service.start(input)
    await terminal(h.service, first.walkthroughId)
    const repeated = await h.service.start(input)
    const separate = await h.service.start({ ...input, requestKey: 'different' })
    await terminal(h.service, separate.walkthroughId)

    expect(repeated).toEqual(first)
    expect(separate.walkthroughId).not.toBe(first.walkthroughId)
    expect(h.diff).toHaveBeenCalledTimes(2)
    h.service.cancel(first.walkthroughId)
    h.service.cancel(first.walkthroughId)
    expect(h.service.snapshot(first.walkthroughId).status).toBe('completed')
  })

  it('freezes a real Git snapshot when the repository changes after start', async () => {
    const repositoryRoot = path.join(root, 'repository')
    await fs.mkdir(repositoryRoot)
    await exec('git', ['init'], { cwd: repositoryRoot })
    await exec('git', ['config', 'user.email', 'test@kaivo.local'], { cwd: repositoryRoot })
    await exec('git', ['config', 'user.name', 'Kaivo Test'], { cwd: repositoryRoot })
    await fs.writeFile(path.join(repositoryRoot, 'a.txt'), 'old\n')
    await exec('git', ['add', 'a.txt'], { cwd: repositoryRoot })
    await exec('git', ['commit', '-m', 'initial'], { cwd: repositoryRoot })
    await fs.writeFile(path.join(repositoryRoot, 'a.txt'), 'new\n')

    const { WalkthroughService } = await import('./service.js')
    const service = new WalkthroughService({ runner: completeRunner() })
    const started = await service.start({
      requestKey: 'real-git', cwd: repositoryRoot,
      comparison: { kind: 'working-tree', branch: { kind: 'branch', originBranch: null, includeUncommitted: true } },
    })
    await terminal(service, started.walkthroughId)
    const frozen = service.snapshot(started.walkthroughId)
    await fs.writeFile(path.join(repositoryRoot, 'a.txt'), 'changed again\n')

    expect(frozen.patch).toContain('+new')
    expect(service.snapshot(started.walkthroughId)).toEqual(frozen)
    expect(service.snapshot(started.walkthroughId).repository.headOid).toMatch(/^[0-9a-f]{40}$/)
  })

  it.each([
    [result('', false), undefined, 'empty'],
    [result(PATCH, true), undefined, 'truncated'],
    [result(PATCH, false), 10, 'oversized'],
    [result('diff --cc a.txt\n@@@ -1,1 -1,1 +1,1 @@@\n'), undefined, 'unsupported'],
  ] as const)('rejects invalid snapshots before inserting a row', async (gitResult, limit, code) => {
    const h = await harness(gitResult, limit)
    await expect(h.service.start({
      requestKey: `invalid-${code}`, cwd: '/repo',
      comparison: { kind: 'working-tree', branch: { kind: 'branch', originBranch: null, includeUncommitted: true } },
    })).rejects.toMatchObject({ code })
    expect((sqliteRaw.prepare('SELECT count(*) AS count FROM walkthroughs').get() as { count: number }).count).toBe(0)
  })

  it('rejects an oversized assembled prompt before creating a workflow or invoking the model', async () => {
    const runner = { run: vi.fn() } as unknown as WalkthroughModelRunner
    const h = await harness(result(), undefined, runner, undefined, 10)

    await expect(h.service.start({
      requestKey: 'input-too-large', cwd: '/repo',
      comparison: { kind: 'working-tree', branch: { kind: 'branch', originBranch: null, includeUncommitted: true } },
    })).rejects.toMatchObject({
      code: 'oversized',
      message: expect.stringContaining('Narrow the comparison'),
    })
    expect(runner.run).not.toHaveBeenCalled()
    expect((sqliteRaw.prepare('SELECT count(*) AS count FROM walkthroughs').get() as { count: number }).count).toBe(0)
  })

  it.each([
    ['refusal', { async *run() { yield { type: 'session' as const, sessionId: 'refusal' }; yield { type: 'text-delta' as const, delta: 'I cannot review this.' }; yield { type: 'finish' as const } } }, undefined],
    ['error', { async *run() { throw new Error('provider exploded') } }, undefined],
    ['oversized', { async *run() { yield { type: 'session' as const, sessionId: 'large' }; yield { type: 'text-delta' as const, delta: 'x'.repeat(100) }; yield { type: 'finish' as const } } }, 20],
  ])('fails %s output without claiming completion', async (_name, runner, maxOutputBytes) => {
    const h = await harness(result(), undefined, runner, maxOutputBytes)
    const started = await h.service.start({
      requestKey: `failure-${_name}`, cwd: '/repo',
      comparison: { kind: 'working-tree', branch: { kind: 'branch', originBranch: null, includeUncommitted: true } },
    })
    await terminal(h.service, started.walkthroughId)
    const snapshot = h.service.snapshot(started.walkthroughId)
    expect(snapshot.status).toBe('failed')
    expect(snapshot.coverage.covered).toBe(0)
    expect(h.service.events(snapshot.id, 0).some((event) => event.type === 'completed')).toBe(false)
  })

  it('persists streamed narrative before completion and ignores callbacks after cancellation', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    const runner: WalkthroughModelRunner = {
      async *run() {
        yield { type: 'session', sessionId: 'slow-session' }
        yield { type: 'text-delta', delta: '# Useful narrative before completion\n\n' }
        await wait
        yield { type: 'text-delta', delta: 'late output' }
        yield { type: 'finish' }
      },
    }
    const h = await harness(result(), undefined, runner)
    const started = await h.service.start({
      requestKey: 'cancel-stream', cwd: '/repo',
      comparison: { kind: 'working-tree', branch: { kind: 'branch', originBranch: null, includeUncommitted: true } },
    })
    await vi.waitFor(() => expect(h.service.snapshot(started.walkthroughId).markdown).toContain('Useful narrative'))
    h.service.cancel(started.walkthroughId)
    release()
    await terminal(h.service, started.walkthroughId)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const snapshot = h.service.snapshot(started.walkthroughId)
    expect(snapshot.status).toBe('cancelled')
    expect(snapshot.markdown).not.toContain('late output')
  })

  it('projects coverage atomically when a split directive receives its closing fence', async () => {
    let closeFence!: () => void
    let finish!: () => void
    const waitForClose = new Promise<void>((resolve) => { closeFence = resolve })
    const waitForFinish = new Promise<void>((resolve) => { finish = resolve })
    const runner: WalkthroughModelRunner = {
      async *run(input) {
        const user = input.messages.find((entry) => entry.role === 'user')?.content ?? ''
        const manifest = JSON.parse(user.split('CANONICAL MANIFEST\n')[1]!.split('\n\nRAW UNIFIED DIFF')[0]!) as {
          digest: string
          files: Array<{ index: number; oldPath: string | null; newPath: string | null }>
        }
        const file = manifest.files[0]!
        const value = { version: 1, diff: manifest.digest, id: 'split', file: { index: file.index, oldPath: file.oldPath, newPath: file.newPath }, collapsed: false }
        yield { type: 'session', sessionId: 'split-session' }
        yield { type: 'text-delta', delta: `# Early narrative\n\n\`\`\`kaivo-diff\n${JSON.stringify(value)}` }
        await waitForClose
        yield { type: 'text-delta', delta: '\n```\n' }
        await waitForFinish
        yield { type: 'finish' }
      },
    }
    const h = await harness(result(), undefined, runner)
    const started = await h.service.start({
      requestKey: 'split-coverage', cwd: '/repo',
      comparison: { kind: 'working-tree', branch: { kind: 'branch', originBranch: null, includeUncommitted: true } },
    })
    await vi.waitFor(() => expect(h.service.snapshot(started.walkthroughId).markdown).toContain('"id":"split"'))
    expect(h.service.snapshot(started.walkthroughId).coverage.covered).toBe(0)

    closeFence()
    await vi.waitFor(() => expect(h.service.snapshot(started.walkthroughId).coverage.missing).toBe(0))
    const events = h.service.events(started.walkthroughId, 0)
    const coverageIndex = events.findIndex((event) => event.type === 'coverage.changed')
    expect(events[coverageIndex - 1]?.type).toBe('markdown.appended')

    finish()
    await terminal(h.service, started.walkthroughId)
    expect(h.service.snapshot(started.walkthroughId).status).toBe('completed')
  })
})
