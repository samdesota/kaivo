// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodeWalkthroughTab } from '../../src/routes/env/tabs/code-walkthrough-tab'
import { WalkthroughDocument } from '../../src/routes/env/tabs/walkthrough-document'

const DIGEST = `sha256:${'a'.repeat(64)}`

function canonical(rowCount = 2) {
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    id: `row-${index}`, unitId: `unit-row-${index}`, index,
    kind: index === 0 ? 'deletion' as const : 'addition' as const,
    raw: `${index === 0 ? '-' : '+'}line ${index}\n`, oldLine: index === 0 ? 1 : null, newLine: index === 0 ? null : index,
  }))
  const metadata = { id: 'meta-0', unitId: 'unit-meta-0', index: 0, kind: 'metadata' as const, raw: 'diff --git a/a.ts b/a.ts\n' }
  const hunk = { id: 'hunk-1', index: 1, kind: 'hunk' as const, header: `@@ -1 +1,${rowCount} @@\n`, oldStart: 1, oldCount: 1, newStart: 1, newCount: rowCount, rows }
  return {
    version: 1 as const, digest: DIGEST, raw: '', byteCount: 0,
    files: [{ id: 'file-0', index: 0, oldPath: 'a.ts', newPath: 'a.ts', status: 'modified' as const, oldMode: null, newMode: null, binary: false, raw: '', sections: [metadata, hunk], unitIds: [metadata.unitId, ...rows.map((row) => row.unitId)] }],
    unitIds: [metadata.unitId, ...rows.map((row) => row.unitId)],
  }
}

function fence(value: Record<string, unknown>) {
  return `\`\`\`kaivo-diff\n${JSON.stringify(value)}\n\`\`\`\n`
}

function directive(overrides: Record<string, unknown> = {}) {
  return { version: 1, diff: DIGEST, id: 'behavior', file: { index: 0, oldPath: 'a.ts', newPath: 'a.ts' }, collapsed: false, ...overrides }
}

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(),
  diff: {
    patch: 'diff', byteCount: 80, files: [{ oldPath: 'a.ts', path: 'a.ts', status: 'modified', additions: 2, deletions: 1, binary: false }],
    additions: 2, deletions: 1, truncated: false,
  },
  snapshot: undefined as undefined | Record<string, unknown>,
  onEvent: undefined as undefined | ((event: { sequence: number; type: string; data: unknown }) => void),
}))

vi.mock('../../src/env-trpc', () => ({
  envTrpc: {
    git: {
      discoverGit: { useQuery: () => ({ data: { root: '/repo', headOid: 'head', branch: 'feature' }, isLoading: false, error: null }) },
      originBranches: { useQuery: () => ({ data: { branches: [{ name: 'main', ref: 'refs/remotes/origin/main' }], defaultBranch: { name: 'main', ref: 'refs/remotes/origin/main' } }, isLoading: false, error: null }) },
      diff: { useQuery: () => ({ data: mocks.diff, isLoading: false, error: null }) },
    },
    walkthrough: {
      start: { useMutation: () => ({ mutate: mocks.start, isPending: false, error: null }) },
      cancel: { useMutation: () => ({ mutate: mocks.cancel, isPending: false }) },
      snapshot: { useQuery: () => ({ data: mocks.snapshot, isLoading: false, error: null }) },
      events: { useSubscription: (_input: unknown, options: { onData: typeof mocks.onEvent }) => { mocks.onEvent = options.onData } },
    },
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.diff.byteCount = 80
  mocks.snapshot = undefined
  mocks.onEvent = undefined
})
afterEach(cleanup)

describe('CodeWalkthroughTab', () => {
  it('starts the selected comparison and returns the durable ID', () => {
    const onWalkthroughIdChange = vi.fn()
    mocks.start.mockImplementation((_input, options) => options.onSuccess({ walkthroughId: 'walk-1' }))
    render(<CodeWalkthroughTab cwd="/repo/subdir" onWalkthroughIdChange={onWalkthroughIdChange} />)

    fireEvent.click(screen.getByRole('button', { name: 'Generate walkthrough' }))

    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      requestKey: expect.any(String),
      comparison: { kind: 'branch', originBranch: null, includeUncommitted: true },
    }), expect.any(Object))
    expect(onWalkthroughIdChange).toHaveBeenCalledWith('walk-1')
  })

  it('blocks generation when the selected diff exceeds the safe input limit', () => {
    mocks.diff.byteCount = 600_001
    render(<CodeWalkthroughTab cwd="/repo" onWalkthroughIdChange={vi.fn()} />)

    expect(screen.getByRole('alert').textContent).toContain('exceed the safe model input limit')
    const generate = screen.getByRole('button', { name: 'Generate walkthrough' })
    expect(generate).toHaveProperty('disabled', true)
    fireEvent.click(generate)
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('renders a deterministic snapshot with coverage and warnings', () => {
    mocks.snapshot = {
      canonical: canonical(),
      markdown: '# Walkthrough\n\nEvery file is included.',
      status: 'completed',
      warnings: ['Generated deterministically.'],
      coverage: { covered: 8, total: 8, missing: 0 },
      error: null,
      sequence: 4,
    }
    render(<CodeWalkthroughTab cwd="/repo" walkthroughId="walk-1" onWalkthroughIdChange={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Walkthrough' })).toBeTruthy()
    expect(screen.getByText('8/8 (100%)')).toBeTruthy()
    expect(screen.getByText('Generated deterministically.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('applies sequenced Markdown and status events after the atomic snapshot cursor', () => {
    mocks.snapshot = {
      canonical: canonical(),
      markdown: '# Starting\n\n', status: 'thinking', warnings: [],
      coverage: { covered: 0, total: 8, missing: 8 }, error: null, sequence: 2,
    }
    render(<CodeWalkthroughTab cwd="/repo" walkthroughId="walk-1" onWalkthroughIdChange={vi.fn()} />)

    act(() => {
      mocks.onEvent?.({ sequence: 3, type: 'status.changed', data: { status: 'streaming' } })
      mocks.onEvent?.({ sequence: 4, type: 'markdown.appended', data: { markdown: 'Useful narrative now.' } })
      mocks.onEvent?.({ sequence: 4, type: 'markdown.appended', data: { markdown: 'duplicate' } })
    })

    expect(screen.getByText('streaming')).toBeTruthy()
    expect(screen.getByText('Useful narrative now.')).toBeTruthy()
    expect(screen.queryByText('duplicate')).toBeNull()
  })

  it('renders exact whole-file, ranged, and metadata-only canonical selections', () => {
    const diff = canonical()
    const { rerender } = render(<WalkthroughDocument canonical={diff} markdown={fence(directive())} />)
    expect(screen.getByText('line 0')).toBeTruthy()
    expect(screen.getByText('line 1')).toBeTruthy()

    rerender(<WalkthroughDocument canonical={diff} markdown={fence(directive({ id: 'range', sections: [{ kind: 'hunk', index: 1, rows: [1, 1] }] }))} />)
    expect(screen.queryByText('line 0')).toBeNull()
    expect(screen.getByText('line 1')).toBeTruthy()

    rerender(<WalkthroughDocument canonical={diff} markdown={fence(directive({ id: 'metadata', sections: [{ kind: 'metadata', index: 0 }] }))} />)
    expect(screen.getByText('diff --git a/a.ts b/a.ts')).toBeTruthy()
    expect(screen.queryByText('line 1')).toBeNull()
  })

  it('renders persisted flat V1 directives as canonical diff embeds', () => {
    const diff = canonical()
    render(<WalkthroughDocument canonical={diff} markdown={fence({
      version: 1,
      manifestDigest: DIGEST,
      id: 'agent-performance-route-entry',
      fileIndex: 0,
      oldPath: 'a.ts',
      newPath: 'a.ts',
      collapsed: false,
    })} />)

    expect(screen.getByText('line 0')).toBeTruthy()
    expect(screen.getByText('line 1')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/manifestDigest/)).toBeNull()
  })

  it('keeps reviewer expansion choices independent from generated defaults and replay', () => {
    const diff = canonical()
    const markdown = fence(directive({ collapsed: false }))
    const view = render(<WalkthroughDocument canonical={diff} markdown={markdown} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse a.ts walkthrough diff' }))
    expect(screen.queryByText('line 1')).toBeNull()

    view.rerender(<WalkthroughDocument canonical={diff} markdown={`${markdown}\nMore replayed narrative.`} />)
    expect(screen.queryByText('line 1')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand a.ts walkthrough diff' }))
    expect(screen.getByText('line 1')).toBeTruthy()
  })

  it('shows pending and malformed directives inline without exposing partial JSON', () => {
    const diff = canonical()
    const view = render(<WalkthroughDocument canonical={diff} markdown={'Readable first.\n\n```kaivo-diff\n{"version":'} />)
    expect(screen.getByText('Readable first.')).toBeTruthy()
    expect(screen.getByText('Receiving diff annotation...')).toBeTruthy()
    expect(screen.queryByText(/"version"/)).toBeNull()

    view.rerender(<WalkthroughDocument canonical={diff} markdown={'Readable first.\n\n```kaivo-diff\n{"version": nope}\n```\n'} />)
    expect(screen.getByRole('alert').textContent).toContain('Invalid directive JSON')
  })

  it('renders large selections immediately and defers only syntax highlighting', () => {
    const diff = canonical(501)
    render(<WalkthroughDocument canonical={diff} markdown={fence(directive())} />)
    expect(screen.getByText('line 500')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Highlight syntax' })).toBeTruthy()
  })
})
