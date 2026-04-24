import { FileViewer } from '../file-viewer'

export function FileTabContent({ path }: { path: string }) {
  return (
    <div className="h-full min-h-0">
      <FileViewer path={path} />
    </div>
  )
}
