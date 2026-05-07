import { describe, expect, it } from 'vitest'
import {
  isFileDraftStale,
  nextFileEditorStateForDraft,
  type FileEditorState,
} from '../../src/routes/env/file-editor-state'

describe('file editor state', () => {
  it('captures the disk mtime when the first local edit starts', () => {
    const next = nextFileEditorStateForDraft(
      { draft: null, draftBaseMtime: null },
      'local edit',
      '2026-05-07T00:00:00.000Z',
    )

    expect(next).toEqual({
      draft: 'local edit',
      draftBaseMtime: '2026-05-07T00:00:00.000Z',
    })
  })

  it('keeps the original draft base mtime across later local edits', () => {
    const state: FileEditorState = {
      draft: 'first edit',
      draftBaseMtime: '2026-05-07T00:00:00.000Z',
    }

    const next = nextFileEditorStateForDraft(state, 'second edit', '2026-05-07T00:00:10.000Z')

    expect(next).toEqual({
      draft: 'second edit',
      draftBaseMtime: '2026-05-07T00:00:00.000Z',
    })
  })

  it('detects a dirty draft whose disk snapshot is newer than its base', () => {
    expect(
      isFileDraftStale(
        { draft: 'local edit', draftBaseMtime: '2026-05-07T00:00:00.000Z' },
        '2026-05-07T00:00:01.000Z',
      ),
    ).toBe(true)
  })
})
