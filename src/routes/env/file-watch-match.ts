type FsEvent = {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
}

export function shouldRefreshFileForFsEvent(evt: FsEvent, filePath: string, absolute?: boolean): boolean {
  if (evt.type !== 'add' && evt.type !== 'change' && evt.type !== 'unlink') return false

  const eventPath = normalizeFilePath(evt.path)
  const panePath = normalizeFilePath(filePath)
  if (!absolute) return panePath === eventPath

  return panePath === eventPath || (eventPath !== '/' && panePath.endsWith(eventPath))
}

function normalizeFilePath(p: string): string {
  const normalized = p.replace(/\\/g, '/').replace(/^\/+/, '')
  return `/${normalized}`.replace(/\/+/g, '/')
}
