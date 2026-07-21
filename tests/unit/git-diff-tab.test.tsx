// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitDiffTab } from '../../src/routes/env/tabs/git-diff-tab'
import { resetGitDiffTransientState } from '../../src/routes/env/tabs/git-diff-tab-state'

const mocks = vi.hoisted(() => ({
  repository: {} as Record<string, unknown>,
  branches: {} as Record<string, unknown>,
  diff: {} as Record<string, unknown>,
  diffInputs: [] as Array<Record<string, unknown>>,
  diffViewProps: {} as Record<string, unknown>,
  utils: {
    discoverGit: { fetch: vi.fn() },
    originBranches: { fetch: vi.fn() },
    diff: { fetch: vi.fn() },
  },
}))

vi.mock('../../src/env-trpc', () => ({
  envTrpc: {
    useUtils: () => ({ git: mocks.utils }),
    git: {
      discoverGit: { useQuery: () => mocks.repository },
      originBranches: { useQuery: () => mocks.branches },
      diff: {
        useQuery: (input: Record<string, unknown>) => {
          mocks.diffInputs.push(input)
          return mocks.diff
        },
      },
    },
  },
}))

vi.mock('../../src/routes/env/agent/parts/diff-view', () => ({
  DiffView: (props: Record<string, unknown>) => {
    mocks.diffViewProps = props
    return <pre data-testid="diff-view">{String(props.diff)}</pre>
  },
}))

const repository = {
  root: '/repo',
  gitDir: '/repo/.git',
  headOid: '1234567890abcdef',
  branch: 'feature',
}

const defaultBranch = {
  name: 'main',
  ref: 'refs/remotes/origin/main',
  oid: 'abcdef1234567890',
  isDefault: true,
}

const releaseBranch = {
  name: 'release',
  ref: 'refs/remotes/origin/release',
  oid: 'fedcba0987654321',
  isDefault: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  resetGitDiffTransientState()
  mocks.repository = { data: repository, isLoading: false, error: null }
  mocks.branches = {
    data: { repository, branches: [defaultBranch], defaultBranch, defaultSource: 'symbolic-ref' },
    isLoading: false,
    error: null,
  }
  mocks.diff = {
    data: {
      repository,
      kind: 'branch',
      baseRef: defaultBranch.ref,
      mergeBaseOid: '11111111',
      patch: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',
      files: [{ oldPath: null, path: 'a.ts', status: 'modified', binary: false, additions: 1, deletions: 1 }],
      additions: 1,
      deletions: 1,
      byteCount: 80,
      truncated: false,
      warnings: [],
    },
    isLoading: false,
    error: null,
  }
  mocks.diffInputs = []
  mocks.diffViewProps = {}
  mocks.utils.discoverGit.fetch.mockResolvedValue(repository)
  mocks.utils.originBranches.fetch.mockResolvedValue(mocks.branches.data)
  mocks.utils.diff.fetch.mockResolvedValue(mocks.diff.data)
})

afterEach(cleanup)

describe('GitDiffTab', () => {
  it('shows initial repository loading without an empty-state flash', () => {
    mocks.repository = { data: undefined, isLoading: true, error: null }

    render(<GitDiffTab cwd="/repo/subdir" />)

    expect(screen.getByLabelText('Git Diff loading')).toBeTruthy()
    expect(screen.getByText('Finding repository…')).toBeTruthy()
    expect(screen.queryByText('No changes')).toBeNull()
  })

  it('renders the default branch summary, counts, and patch', () => {
    render(<GitDiffTab cwd="/repo/subdir" />)

    expect(screen.getByTitle('feature → origin/main')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Base origin branch' }).textContent).toContain('origin/main')
    expect(screen.getByText('1 file')).toBeTruthy()
    expect(screen.getAllByText('+1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('-1').length).toBeGreaterThan(0)
    expect(screen.getByTestId('diff-view').textContent).toContain('diff --git')
    expect(mocks.diffViewProps).toMatchObject({ unbounded: true, hideLargeDiffs: true, files: mocks.diff.data.files })
  })

  it('requests the detected default branch with uncommitted changes included', () => {
    render(<GitDiffTab cwd="/repo/subdir" />)

    expect(mocks.diffInputs.at(-1)).toEqual({
      cwd: '/repo',
      kind: 'branch',
      originBranch: 'main',
      includeUncommitted: true,
    })
  })

  it('renders the successful no-changes state', () => {
    mocks.diff = {
      ...(mocks.diff as { data: Record<string, unknown> }),
      data: { ...(mocks.diff.data as Record<string, unknown>), files: [], patch: '', additions: 0, deletions: 0 },
      isLoading: false,
      error: null,
    }

    render(<GitDiffTab cwd="/repo" />)

    expect(screen.getByText('No changes')).toBeTruthy()
    expect(screen.getByText(/no committed or uncommitted changes/)).toBeTruthy()
  })

  it('switches comparison scope and searches alternate origin branches by keyboard', () => {
    mocks.branches = {
      data: { repository, branches: [defaultBranch, releaseBranch], defaultBranch, defaultSource: 'symbolic-ref' },
      isLoading: false,
      error: null,
    }
    const view = render(<GitDiffTab tabId="controls" cwd="/repo" />)

    const includeUncommitted = screen.getByRole('checkbox', { name: 'Include uncommitted' })
    expect((includeUncommitted as HTMLInputElement).checked).toBe(true)
    fireEvent.click(includeUncommitted)
    expect(mocks.diffInputs.at(-1)).toMatchObject({ kind: 'branch', includeUncommitted: false })

    fireEvent.click(screen.getByRole('button', { name: 'Base origin branch' }))
    const search = screen.getByRole('combobox', { name: 'Search origin branches' })
    fireEvent.change(search, { target: { value: 'release' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(mocks.diffInputs.at(-1)).toMatchObject({ kind: 'branch', originBranch: 'release', includeUncommitted: false })

    fireEvent.change(screen.getByRole('combobox', { name: 'Comparison mode' }), { target: { value: 'working-tree' } })
    expect(mocks.diffInputs.at(-1)).toEqual({ cwd: '/repo', kind: 'working-tree' })
    expect(screen.queryByRole('checkbox', { name: 'Include uncommitted' })).toBeNull()

    view.unmount()
    render(<GitDiffTab tabId="controls" cwd="/repo" />)
    expect((screen.getByRole('combobox', { name: 'Comparison mode' }) as HTMLSelectElement).value).toBe('working-tree')
  })

  it('resets transient controls for a restored tab and retains a successful snapshot while loading', () => {
    const first = render(<GitDiffTab tabId="retained" cwd="/repo" />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Comparison mode' }), { target: { value: 'working-tree' } })
    first.unmount()

    mocks.diff = { data: undefined, isLoading: true, isFetching: true, error: null }
    const retained = render(<GitDiffTab tabId="retained" cwd="/repo" />)
    expect(screen.getByTestId('diff-view').textContent).toContain('diff --git')
    expect((screen.getByRole('combobox', { name: 'Comparison mode' }) as HTMLSelectElement).value).toBe('working-tree')
    retained.unmount()

    resetGitDiffTransientState()
    render(<GitDiffTab tabId="retained" cwd="/repo" />)
    expect((screen.getByRole('combobox', { name: 'Comparison mode' }) as HTMLSelectElement).value).toBe('branch')
    expect((screen.getByRole('checkbox', { name: 'Include uncommitted' }) as HTMLInputElement).checked).toBe(true)
  })

  it('refreshes local identity and adopts a changed default unless the base is explicit', async () => {
    mocks.branches = {
      data: { repository, branches: [defaultBranch, releaseBranch], defaultBranch, defaultSource: 'symbolic-ref' },
      isLoading: false,
      error: null,
    }
    mocks.utils.originBranches.fetch.mockResolvedValue({
      repository,
      branches: [{ ...defaultBranch, isDefault: false }, { ...releaseBranch, isDefault: true }],
      defaultBranch: { ...releaseBranch, isDefault: true },
      defaultSource: 'symbolic-ref',
    })
    render(<GitDiffTab tabId="refresh" cwd="/repo" />)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Git diff' }))
    await waitFor(() => expect(mocks.utils.diff.fetch).toHaveBeenCalledWith(expect.objectContaining({ originBranch: 'release' })))

    fireEvent.click(screen.getByRole('button', { name: 'Base origin branch' }))
    const search = screen.getByRole('combobox', { name: 'Search origin branches' })
    fireEvent.change(search, { target: { value: 'main' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    mocks.utils.diff.fetch.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Git diff' }))
    await waitFor(() => expect(mocks.utils.diff.fetch).toHaveBeenCalledWith(expect.objectContaining({ originBranch: 'main' })))
  })

  it('retains the snapshot and offers retry when explicit refresh fails', async () => {
    mocks.utils.discoverGit.fetch.mockRejectedValue(new Error('refresh failed'))
    render(<GitDiffTab tabId="refresh-error" cwd="/repo" />)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Git diff' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('refresh failed'))
    expect(screen.getByTestId('diff-view')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })

  it('does not apply an older refresh after the comparison changes', async () => {
    let resolveRepository: ((value: typeof repository) => void) | undefined
    mocks.utils.discoverGit.fetch.mockReturnValue(new Promise((resolve) => { resolveRepository = resolve }))
    render(<GitDiffTab tabId="stale-refresh" cwd="/repo" />)

    fireEvent.click(screen.getByRole('button', { name: 'Refresh Git diff' }))
    fireEvent.change(screen.getByRole('combobox', { name: 'Comparison mode' }), { target: { value: 'working-tree' } })
    await act(async () => resolveRepository?.(repository))

    expect(mocks.utils.originBranches.fetch).not.toHaveBeenCalled()
    expect(mocks.diffInputs.at(-1)).toEqual({ cwd: '/repo', kind: 'working-tree' })
  })

  it('renders repository, origin, unborn, timeout, and truncation states', () => {
    mocks.repository = { data: null, isLoading: false, error: null }
    const notRepo = render(<GitDiffTab cwd="/tmp/plain" />)
    expect(screen.getByText('Not a Git repository')).toBeTruthy()
    notRepo.unmount()

    mocks.repository = { data: repository, isLoading: false, error: null }
    mocks.branches = { data: { repository, branches: [], defaultBranch: null, defaultSource: 'none' }, isLoading: false, error: null }
    const noOrigin = render(<GitDiffTab cwd="/repo" />)
    expect(screen.getByText('No origin branches')).toBeTruthy()
    noOrigin.unmount()

    mocks.repository = { data: { ...repository, headOid: null, branch: null }, isLoading: false, error: null }
    mocks.branches = { data: { repository, branches: [defaultBranch], defaultBranch }, isLoading: false, error: null }
    const unborn = render(<GitDiffTab cwd="/repo" />)
    expect(screen.getByText('Unborn HEAD')).toBeTruthy()
    unborn.unmount()

    mocks.repository = { data: repository, isLoading: false, error: null }
    mocks.branches = { data: { repository, branches: [defaultBranch], defaultBranch }, isLoading: false, error: null }
    mocks.diff = { data: undefined, isLoading: false, error: new Error('Git command timed out after 15000ms') }
    const timeout = render(<GitDiffTab cwd="/repo" />)
    expect(screen.getByRole('alert').textContent).toContain('timed out')
    timeout.unmount()

    mocks.diff = {
      data: {
        repository,
        files: [{ path: 'a.ts' }],
        patch: 'diff --git a/a.ts b/a.ts',
        additions: 3,
        deletions: 2,
        truncated: true,
      },
      isLoading: false,
      error: null,
    }
    render(<GitDiffTab cwd="/repo" />)
    expect(screen.getByText(/File metadata and aggregate counts are complete/)).toBeTruthy()
  })

  it('shows rename and binary metadata and navigates the wide list by keyboard', () => {
    mocks.diff = {
      data: {
        ...(mocks.diff.data as Record<string, unknown>),
        files: [
          { oldPath: 'old.ts', path: 'new.ts', status: 'renamed', binary: false, additions: 0, deletions: 0 },
          { oldPath: null, path: 'image.png', status: 'modified', binary: true, additions: null, deletions: null },
        ],
        additions: 0,
        deletions: 0,
      },
      isLoading: false,
      error: null,
    }
    render(<GitDiffTab tabId="navigator" cwd="/repo" />)

    const options = within(screen.getByRole('listbox', { name: 'Changed files' })).getAllByRole('option')
    expect(options[0]?.textContent).toContain('old.ts → new.ts')
    expect(options[1]?.textContent).toContain('Binary')
    fireEvent.keyDown(options[0]!, { key: 'ArrowDown' })
    expect(options[1]?.getAttribute('aria-selected')).toBe('true')
    expect(mocks.diffViewProps.selectedFileId).toBe('1::image.png')
  })

  it('switches to the labeled changed-file selector in a narrow pane', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 600, top: 0, right: 400, bottom: 600, left: 0, x: 0, y: 0, toJSON: () => ({}) })
    const ResizeObserver = vi.fn(function (this: { observe: () => void; disconnect: () => void }, callback: ResizeObserverCallback) {
      this.observe = () => callback([], this as unknown as ResizeObserver)
      this.disconnect = () => undefined
    })
    vi.stubGlobal('ResizeObserver', ResizeObserver)
    render(<GitDiffTab tabId="narrow" cwd="/repo" />)

    expect(screen.getByRole('combobox', { name: 'Changed file' })).toBeTruthy()
    expect(screen.queryByLabelText('Changed files navigator')).toBeNull()
    rect.mockRestore()
    vi.unstubAllGlobals()
  })

  it('reports a changed canonical repository root for durable reconciliation', () => {
    const onRepositoryRootChange = vi.fn()
    render(<GitDiffTab cwd="/repo/subdir" onRepositoryRootChange={onRepositoryRootChange} />)

    expect(onRepositoryRootChange).toHaveBeenCalledWith('/repo')
  })
})
