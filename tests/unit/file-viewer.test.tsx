// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEditorState } from '../../src/routes/env/file-editor-state'
import { FileViewer } from '../../src/routes/env/file-viewer'

type ReadState = {
  isLoading: boolean
  error: Error | null
  data: {
    content: string
    mtime: string
    binary: boolean
    tooLarge: boolean
    size: number
  } | null
  refetch: () => void
}

let readState: ReadState
const writeMutateAsync = vi.hoisted(() => vi.fn())
const watchHandlers = vi.hoisted(() => [] as Array<(evt: { type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'; path: string }) => void>)

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label="editor"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}))

vi.mock('../../src/env-trpc', () => ({
  envTrpc: {
    fs: {
      read: { useQuery: () => readState },
      write: { useMutation: () => ({ isPending: false, mutateAsync: writeMutateAsync }) },
      watch: {
        useSubscription: (
          _input: undefined,
          opts: { onData?: (evt: { type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'; path: string }) => void },
        ) => {
          if (opts.onData) watchHandlers.push(opts.onData)
        },
      },
    },
  },
}))

function renderViewer(props?: { editorState?: FileEditorState; onEditorStateChange?: (state: FileEditorState) => void }) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <FileViewer
        path="/tmp/a.ts"
        absolute
        editorState={props?.editorState}
        onEditorStateChange={props?.onEditorStateChange}
      />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  readState = {
    isLoading: false,
    error: null,
    data: {
      content: 'disk content',
      mtime: '2026-05-07T00:00:00.000Z',
      binary: false,
      tooLarge: false,
      size: 12,
    },
    refetch: vi.fn(),
  }
  writeMutateAsync.mockReset()
  watchHandlers.length = 0
})

afterEach(() => cleanup())

describe('FileViewer render-time freshness', () => {
  it('renders the latest fs.read content for a clean viewer on mount', async () => {
    readState.data = {
      content: 'new disk content',
      mtime: '2026-05-07T00:00:01.000Z',
      binary: false,
      tooLarge: false,
      size: 16,
    }

    renderViewer()

    expect((screen.getByLabelText('editor') as HTMLTextAreaElement).value).toBe('new disk content')
  })

  it('captures fs.read mtime when the first local edit starts', async () => {
    const onEditorStateChange = vi.fn()

    renderViewer({
      editorState: { draft: null, draftBaseMtime: null },
      onEditorStateChange,
    })
    fireEvent.change(screen.getByLabelText('editor'), { target: { value: 'local edit' } })

    expect(onEditorStateChange).toHaveBeenCalledWith({
      draft: 'local edit',
      draftBaseMtime: '2026-05-07T00:00:00.000Z',
    })
  })

  it('does not replace a dirty draft when a newer disk snapshot is read on mount', async () => {
    readState.data = {
      content: 'new disk content',
      mtime: '2026-05-07T00:00:01.000Z',
      binary: false,
      tooLarge: false,
      size: 16,
    }

    renderViewer({
      editorState: {
        draft: 'local edit',
        draftBaseMtime: '2026-05-07T00:00:00.000Z',
      },
    })

    expect((screen.getByLabelText('editor') as HTMLTextAreaElement).value).toBe('local edit')
  })

  it('shows the stale banner only for a dirty draft based on an older disk snapshot', async () => {
    readState.data = {
      content: 'new disk content',
      mtime: '2026-05-07T00:00:01.000Z',
      binary: false,
      tooLarge: false,
      size: 16,
    }

    const clean = renderViewer()
    expect(screen.queryByText('The file on disk is newer than your local edits.')).toBeNull()
    clean.unmount()

    renderViewer({
      editorState: {
        draft: 'local edit',
        draftBaseMtime: '2026-05-07T00:00:00.000Z',
      },
    })

    expect(screen.getByText('The file on disk is newer than your local edits.')).toBeTruthy()
  })

  it('discard changes clears the draft and renders latest disk content', async () => {
    const onEditorStateChange = vi.fn()
    readState.data = {
      content: 'new disk content',
      mtime: '2026-05-07T00:00:01.000Z',
      binary: false,
      tooLarge: false,
      size: 16,
    }

    renderViewer({
      editorState: {
        draft: 'local edit',
        draftBaseMtime: '2026-05-07T00:00:00.000Z',
      },
      onEditorStateChange,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))

    expect(onEditorStateChange).toHaveBeenCalledWith({ draft: null, draftBaseMtime: null })
  })

  it('save writes the draft, clears draft after success, and refreshes fs.read', async () => {
    const onEditorStateChange = vi.fn()
    writeMutateAsync.mockResolvedValue({ ok: true })

    renderViewer({
      editorState: {
        draft: 'local edit',
        draftBaseMtime: '2026-05-07T00:00:00.000Z',
      },
      onEditorStateChange,
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])

    await waitFor(() => expect(writeMutateAsync).toHaveBeenCalledWith({ path: '/tmp/a.ts', content: 'local edit', absolute: true }))
    expect(onEditorStateChange).toHaveBeenCalledWith({ draft: null, draftBaseMtime: null })
  })

  it('failed save keeps draft and stale banner', async () => {
    writeMutateAsync.mockRejectedValue(new Error('write failed'))
    readState.data = {
      content: 'new disk content',
      mtime: '2026-05-07T00:00:01.000Z',
      binary: false,
      tooLarge: false,
      size: 16,
    }

    renderViewer({
      editorState: {
        draft: 'local edit',
        draftBaseMtime: '2026-05-07T00:00:00.000Z',
      },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])

    await waitFor(() => expect(screen.getByText('write failed')).toBeTruthy())
    expect((screen.getByLabelText('editor') as HTMLTextAreaElement).value).toBe('local edit')
    expect(screen.getByText('The file on disk is newer than your local edits.')).toBeTruthy()
  })

  it('clean viewer shows read error after deleted-file refresh', async () => {
    readState.error = new Error('file not found')
    readState.data = null

    renderViewer()

    expect(screen.getByText('file not found')).toBeTruthy()
    expect(screen.queryByLabelText('editor')).toBeNull()
  })

  it('dirty viewer keeps draft and shows deleted-file banner after deleted-file refresh', async () => {
    readState.error = new Error('file not found')
    readState.data = null

    renderViewer({
      editorState: {
        draft: 'local edit',
        draftBaseMtime: '2026-05-07T00:00:00.000Z',
      },
    })

    expect((screen.getByLabelText('editor') as HTMLTextAreaElement).value).toBe('local edit')
    expect(screen.getByText('The file was deleted on disk while you have local edits.')).toBeTruthy()
  })

  it('detects stale disk snapshot after remount without any watch event', async () => {
    readState.data = {
      content: 'original disk content',
      mtime: '2026-05-07T00:00:00.000Z',
      binary: false,
      tooLarge: false,
      size: 21,
    }
    const first = renderViewer({
      editorState: {
        draft: 'local edit',
        draftBaseMtime: '2026-05-07T00:00:00.000Z',
      },
    })
    expect(screen.queryByText('The file on disk is newer than your local edits.')).toBeNull()
    first.unmount()

    readState.data = {
      content: 'externally edited content',
      mtime: '2026-05-07T00:00:01.000Z',
      binary: false,
      tooLarge: false,
      size: 25,
    }
    renderViewer({
      editorState: {
        draft: 'local edit',
        draftBaseMtime: '2026-05-07T00:00:00.000Z',
      },
    })

    expect((screen.getByLabelText('editor') as HTMLTextAreaElement).value).toBe('local edit')
    expect(screen.getByText('The file on disk is newer than your local edits.')).toBeTruthy()
  })

  it('saving a dirty deleted file writes the draft and clears stale state after refetch', async () => {
    const onEditorStateChange = vi.fn()
    writeMutateAsync.mockResolvedValue({ ok: true })
    readState.error = new Error('file not found')
    readState.data = null

    renderViewer({
      editorState: {
        draft: 'local edit',
        draftBaseMtime: '2026-05-07T00:00:00.000Z',
      },
      onEditorStateChange,
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0])

    await waitFor(() => expect(writeMutateAsync).toHaveBeenCalledWith({ path: '/tmp/a.ts', content: 'local edit', absolute: true }))
    expect(onEditorStateChange).toHaveBeenCalledWith({ draft: null, draftBaseMtime: null })
  })

  it('refetches when a matching file watch event arrives', async () => {
    renderViewer()

    watchHandlers.at(-1)?.({ type: 'change', path: '/tmp/a.ts' })

    expect(readState.refetch).toHaveBeenCalledTimes(1)
  })

  it('ignores unrelated and directory watch events', async () => {
    renderViewer()

    watchHandlers.at(-1)?.({ type: 'change', path: '/tmp/b.ts' })
    watchHandlers.at(-1)?.({ type: 'addDir', path: '/tmp' })

    expect(readState.refetch).not.toHaveBeenCalled()
  })
})
