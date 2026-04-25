import { FileViewer } from '../file-viewer'

export function FileTabContent({ path, absolute }: { path: string; absolute?: boolean }) {
  return (
    <div className="h-full min-h-0">
      <FileViewer path={path} absolute={absolute} />
    </div>
  )
}
