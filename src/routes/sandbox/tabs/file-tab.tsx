import { FileViewer } from '../file-viewer'

export function FileTabContent({ sandboxId, path }: { sandboxId: string; path: string }) {
  return (
    <div className="h-full min-h-0">
      <FileViewer sandboxId={sandboxId} path={path} />
    </div>
  )
}
