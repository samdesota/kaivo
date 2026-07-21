// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiffView } from '../../src/routes/env/agent/parts/diff-view'
import { parseUnifiedDiff } from '../../src/routes/env/agent/parts/diff-model'

afterEach(cleanup)

function patchWithLines(count: number) {
  return [
    'diff --git a/large.ts b/large.ts',
    '--- a/large.ts',
    '+++ b/large.ts',
    '@@ -0,0 +1 @@',
    ...Array.from({ length: count }, (_, index) => `+line ${index}`),
  ].join('\n')
}

describe('DiffView sizing', () => {
  it('keeps the agent height constraint by default', () => {
    const { container } = render(<DiffView diff={patchWithLines(1)} />)

    expect(container.querySelector('.max-h-\\[32rem\\]')).toBeTruthy()
  })

  it('renders ordinary unbounded diffs without a height constraint', () => {
    const { container } = render(<DiffView diff={patchWithLines(2)} unbounded hideLargeDiffs />)

    expect(container.querySelector('.max-h-\\[32rem\\]')).toBeNull()
    expect(screen.queryByText(/Large diff hidden/)).toBeNull()
    expect(screen.getByText('line 1')).toBeTruthy()
  })

  it('hides a large diff until requested', () => {
    const { container } = render(<DiffView diff={patchWithLines(501)} unbounded hideLargeDiffs />)

    expect(screen.getByText('Large diff hidden (501 changed lines).')).toBeTruthy()
    expect(screen.queryByText('line 500')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show diff' }))

    expect(screen.getByText('line 500')).toBeTruthy()
    expect(container.querySelector('.max-h-\\[32rem\\]')).toBeNull()
  })

  it('reports controlled file expansion changes', () => {
    const changes: Array<[string, boolean]> = []
    render(
      <DiffView
        diff={patchWithLines(1)}
        fileExpansion={{ '0::large.ts': false }}
        onFileExpansionChange={(fileId, open) => changes.push([fileId, open])}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Expand large.ts diff' }))
    expect(changes).toEqual([['0::large.ts', true]])
  })

  it('highlights only expanded files and scrolls selected sections with reduced motion respected', async () => {
    const scrollIntoView = vi.fn()
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = scrollIntoView
    const originalMatchMedia = window.matchMedia
    window.matchMedia = vi.fn(() => ({ matches: true })) as unknown as typeof window.matchMedia
    const id = '0::large.ts'
    const view = render(<DiffView diff={patchWithLines(1)} fileExpansion={{ [id]: false }} selectedFileId={id} />)

    expect(screen.queryByText('line 0')).toBeNull()
    expect(view.container.querySelector('span[style]')).toBeNull()
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
    view.rerender(<DiffView diff={patchWithLines(1)} fileExpansion={{ [id]: true }} selectedFileId={id} />)
    await waitFor(() => expect(view.container.querySelector('span[style]')).toBeTruthy())

    HTMLElement.prototype.scrollIntoView = originalScrollIntoView
    window.matchMedia = originalMatchMedia
  })
})

describe('unified diff parsing', () => {
  it('parses multiple files and hunks without counting patch headers', () => {
    const files = parseUnifiedDiff([
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '@@ -8 +8 @@',
      ' context',
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1 @@',
      '+created',
    ].join('\n'))

    expect(files).toMatchObject([
      { path: 'a.ts', status: 'modified', additions: 1, deletions: 1 },
      { path: 'new.ts', status: 'added', additions: 1, deletions: 0 },
    ])
    expect(files[0]?.lines.filter((line) => line.kind === 'hunk')).toHaveLength(2)
  })

  it('decodes quoted paths and represents deletes and renames', () => {
    const files = parseUnifiedDiff([
      'diff --git "a/tab\\tname.ts" "b/tab\\tname.ts"',
      'deleted file mode 100644',
      '--- "a/tab\\tname.ts"',
      '+++ /dev/null',
      '-gone',
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n'))

    expect(files[0]).toMatchObject({ path: 'tab\tname.ts', status: 'deleted' })
    expect(files[1]).toMatchObject({ oldPath: 'old.ts', path: 'new.ts', status: 'renamed' })
  })

  it('uses structured binary metadata and marks a truncated final section', () => {
    const metadata = [
      { oldPath: null, path: 'image.bin', status: 'modified' as const, binary: true, additions: null, deletions: null },
      { oldPath: null, path: 'partial.ts', status: 'modified' as const, binary: false, additions: 12, deletions: 3 },
    ]
    const patch = 'diff --git a/image.bin b/image.bin\nGIT binary patch\nliteral 4\nAbCd\ndiff --git a/partial.ts b/partial.ts\n@@ -1 +1 @@\n-old'
    const files = parseUnifiedDiff(patch, metadata, true)

    expect(files[0]).toMatchObject({ binary: true, additions: null, deletions: null, incomplete: false })
    expect(files[1]).toMatchObject({ additions: 12, deletions: 3, incomplete: true })
  })

  it('renders binary and truncated placeholders instead of binary payload', () => {
    render(<DiffView
      diff={'diff --git a/image.bin b/image.bin\nGIT binary patch\nliteral 4\nSECRET'}
      files={[{ oldPath: null, path: 'image.bin', status: 'modified', binary: true, additions: null, deletions: null }]}
      truncated
    />)

    expect(screen.getByText('Binary file changed. No text diff is available.')).toBeTruthy()
    expect(screen.queryByText('SECRET')).toBeNull()
    expect(screen.getByText(/section may be incomplete/)).toBeTruthy()
  })
})
