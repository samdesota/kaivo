import { FileViewer } from '../file-viewer'
import type { FileEditorState } from '../file-editor-state'

export function FileTabContent({
  path,
  absolute,
  editorState,
  onEditorStateChange,
}: {
  path: string
  absolute?: boolean
  editorState?: FileEditorState
  onEditorStateChange?: (state: FileEditorState) => void
}) {
  return (
    <div className="h-full min-h-0 bg-neutral-975">
      <FileViewer
        path={path}
        absolute={absolute}
        editorState={editorState}
        onEditorStateChange={onEditorStateChange}
      />
    </div>
  )
}
