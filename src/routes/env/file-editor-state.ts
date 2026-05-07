export type FileEditorState = {
  draft: string | null
  draftBaseMtime: string | null
}

export const emptyFileEditorState: FileEditorState = {
  draft: null,
  draftBaseMtime: null,
}

export function normalizeFileMtime(mtime: string | Date | null | undefined): string | null {
  if (!mtime) return null
  return mtime instanceof Date ? mtime.toISOString() : mtime
}

export function nextFileEditorStateForDraft(
  state: FileEditorState,
  draft: string,
  diskMtime: string | Date | null | undefined,
): FileEditorState {
  return {
    ...state,
    draft,
    draftBaseMtime: state.draft === null ? normalizeFileMtime(diskMtime) : state.draftBaseMtime,
  }
}

export function isFileDraftStale(
  state: FileEditorState,
  diskMtime: string | Date | null | undefined,
): boolean {
  if (state.draft === null || !state.draftBaseMtime) return false
  const latest = normalizeFileMtime(diskMtime)
  return latest !== null && Date.parse(latest) > Date.parse(state.draftBaseMtime)
}
