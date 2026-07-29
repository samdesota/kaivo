import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'
import { GitService, type GitDiffInput } from '../../packages/env-server/src/git/service'
import { assembleDeterministicWalkthrough } from '../../packages/env-server/src/walkthrough/directives'
import { parseCanonicalDiff } from '../../packages/env-server/src/walkthrough/parser'

const execFileAsync = promisify(execFile)

test('opens and restores the default Git diff from Command-T', async ({ page }) => {
  const fixture = await createRepositoryFixture()
  const sessionId = `git-session-${Date.now()}`
  const env = await startGitEnvServer(fixture.root, 4096, sessionId)
  try {
    await page.setViewportSize({ width: 1600, height: 900 })
    await login(page)
    const workspace = await trpcMutation<{ id: string; name: string }>(page, 'workspace.create', { name: `Git Diff ${Date.now()}` })
    await trpcMutation(page, 'env.registerLocal', {
      url: env.url,
      envToken: `git-diff-e2e-token-${Date.now()}`,
      label: 'Git diff env',
      localIdentityLabel: 'playwright',
    })
    await trpcMutation(page, 'workspace.saveViewState', { workspaceId: workspace.id, state: { activeAgentSessionId: sessionId } })
    await page.goto(`/w/${workspace.id}`)
    await waitForAppDataReady(page)

    await page.keyboard.press('Meta+t')
    await page.getByLabel('Universal menu search').fill('git diff')
    await page.getByRole('button', { name: /Open Git Diff/ }).click()

    await expect(page.getByRole('tab', { name: /Git Diff/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Base origin branch' })).toContainText('origin/main')
    await expect(page.getByText('committed feature line')).toBeVisible()
    await expect(page.getByText('uncommitted working line')).toBeVisible()
    await expect(page.locator('header').getByText('4 files')).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Changed files navigator' })).toBeVisible()

    const changedFiles = page.getByRole('listbox', { name: 'Changed files' })
    await expect(changedFiles.getByRole('option', { name: /old\.ts → new\.ts/ })).toBeVisible()
    await expect(changedFiles.getByRole('option', { name: /image\.dat.*Binary/ })).toBeVisible()
    const firstFile = changedFiles.getByRole('option').first()
    await firstFile.focus()
    await firstFile.press('ArrowDown')
    await expect(changedFiles.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')

    await changedFiles.getByRole('option', { name: /old\.ts → new\.ts/ }).click()
    await page.getByRole('button', { name: 'Collapse new.ts diff' }).click()
    await expect(page.getByRole('button', { name: 'Expand new.ts diff' })).toBeVisible()

    await page.setViewportSize({ width: 760, height: 900 })
    await expect(page.getByRole('combobox', { name: 'Changed file' })).toBeVisible()
    await expect(page.getByRole('complementary', { name: 'Changed files navigator' })).toHaveCount(0)
    await page.setViewportSize({ width: 1600, height: 900 })

    await page.getByRole('checkbox', { name: 'Include uncommitted' }).uncheck()
    await expect(page.getByText('committed feature line')).toBeVisible()
    await expect(page.getByText('uncommitted working line')).toHaveCount(0)
    await expect(page.locator('header').getByText('3 files')).toBeVisible()

    await page.getByRole('button', { name: 'Base origin branch' }).click()
    await page.getByRole('combobox', { name: 'Search origin branches' }).fill('release')
    await page.getByRole('combobox', { name: 'Search origin branches' }).press('Enter')
    await expect(page.getByText('No changes')).toBeVisible()

    await page.getByRole('combobox', { name: 'Comparison mode' }).selectOption('working-tree')
    await expect(page.getByText('uncommitted working line')).toBeVisible()
    await expect(page.getByText('committed feature line')).toHaveCount(0)
    await expect(page.locator('header').getByText('1 file')).toBeVisible()

    await fs.writeFile(path.join(fixture.root, 'refreshed.txt'), 'newly refreshed line\n')
    await page.getByRole('button', { name: 'Refresh Git diff' }).click()
    await expect(page.getByText('newly refreshed line')).toBeVisible()
    await expect(page.locator('header').getByText('2 files')).toBeVisible()

    await fs.writeFile(path.join(fixture.root, 'zz-large.txt'), `${'large diff line\n'.repeat(800)}`)
    await page.getByRole('button', { name: 'Refresh Git diff' }).click()
    await expect(page.getByText(/Diff output was truncated/)).toBeVisible()
    await expect(page.getByText(/aggregate counts are complete/)).toBeVisible()

    await fs.rename(path.join(fixture.root, '.git'), path.join(fixture.root, '.git-hidden'))
    await page.getByRole('button', { name: 'Refresh Git diff' }).click()
    await expect(page.getByRole('alert')).toContainText('Repository is no longer available')
    await fs.rename(path.join(fixture.root, '.git-hidden'), path.join(fixture.root, '.git'))
    await page.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByRole('alert')).toHaveCount(0)

    await page.keyboard.press('Meta+t')
    await page.getByLabel('Universal menu search').fill('git diff')
    await page.getByRole('button', { name: /Open Git Diff/ }).click()
    await expect(page.getByRole('tab', { name: /Git Diff/ })).toHaveCount(1)

    await page.reload()
    await waitForAppDataReady(page)
    await expect(page.getByRole('tab', { name: /Git Diff/ })).toBeVisible()
    await expect(page.getByText('uncommitted working line')).toBeVisible()

    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/trpc/workspace.deleteTab') && response.ok()),
      page.getByRole('tab', { name: /Git Diff/ }).getByRole('button', { name: 'Close tab' }).click(),
    ])
    await expect(page.getByRole('tab', { name: /Git Diff/ })).toHaveCount(0)
    await page.keyboard.press('Meta+t')
    await page.getByLabel('Universal menu search').fill('git diff')
    await page.getByRole('button', { name: /Open Git Diff/ }).click()
    await expect(page.getByRole('tab', { name: /Git Diff/ })).toHaveCount(1)
  } finally {
    await env.close()
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('generates complete walkthroughs for branch and working-tree comparisons', async ({ page }) => {
  const fixture = await createRepositoryFixture()
  const sessionId = `walkthrough-session-${Date.now()}`
  const env = await startGitEnvServer(fixture.root, undefined, sessionId)
  try {
    await page.setViewportSize({ width: 1400, height: 900 })
    await login(page)
    const workspace = await trpcMutation<{ id: string; name: string }>(page, 'workspace.create', { name: `Code Walkthrough ${Date.now()}` })
    await trpcMutation(page, 'env.registerLocal', {
      url: env.url,
      envToken: `walkthrough-e2e-token-${Date.now()}`,
      label: 'Walkthrough env',
      localIdentityLabel: 'playwright',
    })
    await trpcMutation(page, 'workspace.saveViewState', { workspaceId: workspace.id, state: { activeAgentSessionId: sessionId } })
    await page.goto(`/w/${workspace.id}`)
    await waitForAppDataReady(page)

    await openCodeWalkthrough(page)
    await expect(page.getByRole('button', { name: 'Base origin branch' })).toContainText('origin/main')
    await page.getByRole('button', { name: 'Generate walkthrough' }).click()
    await expect(page.getByRole('heading', { name: 'committed.txt' })).toBeVisible()
    await expect(page.getByText('committed feature line')).toBeVisible()
    await expect(page.getByText('Coverage').locator('span')).toContainText('100%')
    await expect(page.getByRole('heading', { name: 'old.ts -> new.ts' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'image.dat' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'working.txt' })).toBeVisible()
    await page.setViewportSize({ width: 480, height: 800 })
    await expect(page.getByText('uncommitted working line')).toBeVisible()
    const contained = await page.getByRole('article').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    expect(contained).toBe(true)

    await page.reload()
    await waitForAppDataReady(page)
    await expect(page.getByRole('heading', { name: 'committed.txt' })).toBeVisible()
    await expect(page.getByText('Coverage').locator('span')).toContainText('100%')

    await page.getByRole('tab', { name: /Code Walkthrough/ }).getByRole('button', { name: 'Close tab' }).click()
    await openCodeWalkthrough(page)
    await page.getByRole('combobox', { name: 'Comparison mode' }).selectOption('working-tree')
    await page.getByRole('button', { name: 'Generate walkthrough' }).click()
    await expect(page.getByRole('heading', { name: 'working.txt' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'committed.txt' })).toHaveCount(0)
    await expect(page.getByText('Coverage').locator('span')).toContainText('100%')
  } finally {
    await env.close()
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

async function openCodeWalkthrough(page: Page) {
  await page.keyboard.press('Meta+t')
  await page.getByLabel('Universal menu search').fill('code walkthrough')
  await page.getByRole('button', { name: /Open Code Walkthrough/ }).click()
  await expect(page.getByRole('tab', { name: /Code Walkthrough/ })).toBeVisible()
}

async function createRepositoryFixture(): Promise<{ root: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kaivo-git-diff-e2e-'))
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root })
  await execFileAsync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: root })
  await execFileAsync('git', ['config', 'user.name', 'Kaivo E2E'], { cwd: root })
  await fs.writeFile(path.join(root, 'base.txt'), 'base line\n')
  await fs.writeFile(path.join(root, 'old.ts'), 'rename me\n')
  await fs.writeFile(path.join(root, 'image.dat'), Buffer.from([0, 1, 2, 3]))
  await execFileAsync('git', ['add', '.'], { cwd: root })
  await execFileAsync('git', ['commit', '-m', 'base'], { cwd: root })
  await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: root })
  await execFileAsync('git', ['checkout', '-b', 'feature'], { cwd: root })
  await execFileAsync('git', ['mv', 'old.ts', 'new.ts'], { cwd: root })
  await fs.writeFile(path.join(root, 'image.dat'), Buffer.from([0, 4, 5, 6]))
  await fs.writeFile(path.join(root, 'committed.txt'), 'committed feature line\n')
  await execFileAsync('git', ['add', '.'], { cwd: root })
  await execFileAsync('git', ['commit', '-m', 'feature'], { cwd: root })
  await execFileAsync('git', ['update-ref', 'refs/remotes/origin/release', 'HEAD'], { cwd: root })
  await fs.writeFile(path.join(root, 'working.txt'), 'uncommitted working line\n')
  return { root: await fs.realpath(root) }
}

async function startGitEnvServer(repoRoot: string, maxPatchBytes?: number, sessionId = 'git-session'): Promise<{ url: string; close: () => Promise<void> }> {
  const gitService = new GitService({ maxPatchBytes })
  const walkthroughs = new Map<string, unknown>()

  const server = http.createServer(async (req, res) => {
    setCors(res)
    if (req.method === 'OPTIONS') return sendJson(res, {}, 204)
    if (req.url === '/healthz') return sendJson(res, { ok: true, kind: 'local', label: 'Git diff env', paired: true })
    const requestUrl = req.url ?? ''
    if (!requestUrl.startsWith('/trpc/')) return sendJson(res, {}, 404)
    const procedures = decodeURIComponent(requestUrl.slice('/trpc/'.length).split('?')[0] ?? '').split(',')
    const url = new URL(requestUrl, 'http://127.0.0.1')
    const rawInput = req.method === 'POST' ? await readBody(req) : url.searchParams.get('input')
    let parsedInput: Record<string, { json?: unknown }> & { json?: unknown } | null = null
    try {
      parsedInput = rawInput ? JSON.parse(rawInput) as Record<string, { json?: unknown }> & { json?: unknown } : null
    } catch (error) {
      console.error('Failed to parse mock environment request', { requestUrl, rawInput, error })
      return sendJson(res, trpcError(error), 400)
    }
    const inputAt = (index: number) => parsedInput?.[String(index)]?.json ?? parsedInput?.json
    const results = await Promise.all(procedures.map(async (procedure, index) => {
      try {
        if (procedure === 'agent.sessionList') return trpcResult([{ id: sessionId, title: 'Git session', status: 'active', workingDir: repoRoot, createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() }])
        if (procedure === 'git.discoverGit') return trpcResult(await gitService.discoverGit((inputAt(index) as { cwd: string }).cwd))
        if (procedure === 'git.originBranches') return trpcResult(await gitService.originBranches((inputAt(index) as { cwd: string }).cwd))
        if (procedure === 'git.diff') return trpcResult(await gitService.diff(inputAt(index) as GitDiffInput))
        if (procedure === 'walkthrough.start') {
          const input = inputAt(index) as {
            cwd: string
            comparison: { kind: 'branch'; originBranch: string | null; includeUncommitted: boolean } | { kind: 'working-tree' }
          }
          const walkthroughId = `walkthrough-${walkthroughs.size + 1}`
          const originBranch = input.comparison.kind === 'branch'
            ? input.comparison.originBranch ?? (await gitService.originBranches(input.cwd)).defaultBranch?.name ?? ''
            : null
          const diff = await gitService.diff(input.comparison.kind === 'working-tree'
            ? { cwd: input.cwd, kind: 'working-tree' }
            : { cwd: input.cwd, kind: 'branch', originBranch: originBranch!, includeUncommitted: input.comparison.includeUncommitted })
          const canonical = parseCanonicalDiff(diff.patch, { truncated: diff.truncated })
          const document = assembleDeterministicWalkthrough(canonical)
          walkthroughs.set(walkthroughId, {
            id: walkthroughId,
            status: 'completed',
            markdown: document.markdown,
            canonical,
            warnings: diff.warnings,
            coverage: { covered: canonical.unitIds.length, total: canonical.unitIds.length, missing: 0 },
            error: null,
            sequence: 1,
          })
          return trpcResult({ walkthroughId })
        }
        if (procedure === 'walkthrough.snapshot') {
          const { walkthroughId } = inputAt(index) as { walkthroughId: string }
          return trpcResult(walkthroughs.get(walkthroughId) ?? null)
        }
        if (procedure === 'walkthrough.cancel') return trpcResult({ ok: true })
        if (procedure === 'agent.agentStatus') return trpcResult({ hasProvider: true, ready: true })
        if (procedure === 'fs.browseHome') return trpcResult({ path: repoRoot, home: repoRoot, defaultPath: repoRoot, dirs: [], files: [] })
        if (procedure === 'repo.listRecentFolders' || procedure === 'repo.listConfigs' || procedure === 'repo.listWorktrees' || procedure === 'shell.list' || procedure === 'agent.sessionMessages' || procedure === 'agent.childTranscripts') return trpcResult([])
        if (procedure === 'agent.transcriptLatestSeq') return trpcResult({ seq: 0 })
        if (procedure === 'agent.sessionStatus') return trpcResult({ status: 'active' })
        return trpcResult(null)
      } catch (error) {
        return trpcError(error)
      }
    }))
    const batch = new URL(requestUrl, 'http://127.0.0.1').searchParams.get('batch') === '1'
    sendJson(res, batch ? results : results[0])
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock env server did not bind')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : null
}

async function login(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Password').fill('e2e-password-123')
  await Promise.all([
    page.waitForResponse((response) => response.url().includes('/trpc/auth.login') && response.ok()),
    page.getByRole('button', { name: 'Sign in' }).click(),
  ])
}

async function waitForAppDataReady(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __kaivoAppDataReady?: boolean }).__kaivoAppDataReady ?? false)).toBe(true)
}

async function trpcMutation<T>(page: Page, procedure: string, input?: unknown): Promise<T> {
  return await page.evaluate(async ({ procedure, input }) => {
    const response = await fetch(`/trpc/${procedure}`, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: JSON.stringify({ json: input }) })
    if (!response.ok) throw new Error(`${procedure} failed: ${response.status} ${await response.text()}`)
    return ((await response.json()) as { result: { data: { json: T } } }).result.data.json
  }, { procedure, input })
}

function trpcResult(json: unknown) {
  return { result: { data: { json } } }
}

function trpcError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Git operation failed'
  return { error: { json: { message, code: -32603, data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 } } } }
}

function setCors(res: http.ServerResponse) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  res.setHeader('access-control-allow-headers', 'authorization,content-type,trpc-accept')
}

function sendJson(res: http.ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(status === 204 ? undefined : JSON.stringify(body))
}
