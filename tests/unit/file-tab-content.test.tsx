// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileEditorState } from '../../src/routes/env/file-editor-state'

const fileViewerCalls: Array<{
  path: string
  absolute?: boolean
  editorState?: FileEditorState
  onEditorStateChange?: (state: FileEditorState) => void
}> = []

vi.mock('../../src/routes/env/file-viewer', () => ({
  FileViewer: (props: {
    path: string
    absolute?: boolean
    editorState?: FileEditorState
    onEditorStateChange?: (state: FileEditorState) => void
  }) => {
    fileViewerCalls.push(props)
    return <div data-testid="file-viewer">{props.editorState?.draft ?? ''}</div>
  },
}))

afterEach(() => {
  cleanup()
  fileViewerCalls.length = 0
})

describe('FileTabContent', () => {
  it('restores tab-scoped draft state when a file tab remounts', async () => {
    const { FileTabContent } = await import('../../src/routes/env/tabs/file-tab')
    const editorState: FileEditorState = {
      draft: 'local edit',
      draftBaseMtime: '2026-05-07T00:00:00.000Z',
    }

    const first = render(<FileTabContent path="/tmp/a.ts" absolute editorState={editorState} />)
    expect(screen.getByTestId('file-viewer').textContent).toBe('local edit')
    first.unmount()

    render(<FileTabContent path="/tmp/a.ts" absolute editorState={editorState} />)

    expect(fileViewerCalls).toHaveLength(2)
    expect(fileViewerCalls[1]).toMatchObject({
      path: '/tmp/a.ts',
      absolute: true,
      editorState,
    })
    expect(screen.getByTestId('file-viewer').textContent).toBe('local edit')
  })
})
