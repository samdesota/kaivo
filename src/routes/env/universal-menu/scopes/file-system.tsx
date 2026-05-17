import { startTransition, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { paneTabIconForType, TabIconView } from '../../../../components/tab-icon'
import { envTrpc } from '../../../../env-trpc'
import { extractTrpcMessage } from '../../../../lib/utils'
import { UniversalMenuResultList, rowClassName, selectResult } from '../shared'
import type { UniversalMenuRenderState, UniversalMenuResult, UniversalScopeModule, UniversalScopeProps } from '../types'
import { basename, disabledRow } from '../utils'

interface FolderBrowseDir {
  name: string
  path: string
}

interface FolderBrowseData {
  path: string
  home?: string | null
  defaultPath?: string | null
  parent?: string | null
  dirs: FolderBrowseDir[]
  files?: FolderBrowseDir[]
}

interface FolderBrowsePlan {
  dir: string | undefined
  filter: string
}

export const fileSystemScopeModule: UniversalScopeModule = {
  id: 'open-folder',
  label: 'File System',
  key: '/',
  detail: 'Open files or choose folders for chats',
  placeholder: 'File system browsing lands in Task 3',
  Component: FileSystemScope,
}

export function FileSystemScope(props: UniversalScopeProps) {
  const { activeIndex, mouseMoved, onActiveChange, onClose, onCreatedChat, onMouseMoved, onOpenContent, openDetails, query, setQuery, setScopeApi, workspaceId } = props
  const [folderPath, setFolderPath] = useState<string | undefined>(undefined)
  const previousResultsRef = useRef<UniversalMenuResult[]>([])
  const envUtils = envTrpc.useUtils()
  const folderProbe = envTrpc.fs.browseHome.useQuery({ path: undefined }, { refetchOnWindowFocus: false, staleTime: 30_000 })
  const folderBrowsePlan = useMemo(() => {
    if (!isPathLikeInput(query)) return null
    const probe = folderProbe.data as FolderBrowseData | undefined
    return pathBrowsePlan(query, { home: probe?.home ?? undefined, defaultPath: probe?.defaultPath ?? undefined })
  }, [folderProbe.data, query])
  const folderBrowse = envTrpc.fs.browseHome.useQuery({ path: folderBrowsePlan ? folderBrowsePlan.dir : folderPath }, { refetchOnWindowFocus: false })
  const startChat = envTrpc.agent.sessionStart.useMutation()
  const createDirectory = envTrpc.fs.createDirectory.useMutation()

  function drillIntoFolder(path: string) {
    startTransition(() => setFolderPath(path))
    const probe = folderProbe.data as FolderBrowseData | undefined
    setQuery(pathInputForAbsolutePath(path, query, { home: probe?.home, defaultPath: probe?.defaultPath }))
  }

  const results = useMemo(() => {
    const next = openFolderScopeResults({
      data: folderBrowse.data as FolderBrowseData | undefined,
      error: folderBrowse.error,
      loading: folderBrowse.isLoading,
      filter: folderBrowsePlan ? folderBrowsePlan.filter : query,
      workspaceId,
      startChat: async (path) => {
        if (!workspaceId) return
        const created = await startChat.mutateAsync({ workspaceId, directory: path }) as { id: string }
        onCreatedChat?.(created.id, workspaceId)
      },
      openFile: (path) => onOpenContent?.({ type: 'file', path, absolute: true }),
      drillFolder: drillIntoFolder,
      createFolder: async (parentPath, name) => {
        const created = await createDirectory.mutateAsync({ parentPath, name }) as FolderBrowseDir
        await envUtils.fs.browseHome.invalidate()
        drillIntoFolder(created.path)
      },
      openNewWorkspaceChat: (path) => openDetails({ type: 'folder', path }),
    })
    if (folderBrowse.isLoading && previousResultsRef.current.length > 0) return previousResultsRef.current
    if (!folderBrowse.isLoading && next.length > 0) previousResultsRef.current = next
    return next
  }, [createDirectory, envUtils.fs.browseHome, folderBrowse.data, folderBrowse.error, folderBrowse.isLoading, folderBrowsePlan, onCreatedChat, onOpenContent, openDetails, query, startChat, workspaceId])

  const openFolderFilter = (folderBrowsePlan ? folderBrowsePlan.filter : query).trim()
  const effectiveActiveIndex = openFolderFilter && results.length > 1 && activeIndex === 0 ? 1 : activeIndex

  useLayoutEffect(() => {
    const browsePath = folderBrowsePlan?.dir ?? (folderBrowse.data as FolderBrowseData | undefined)?.path
    setScopeApi({
      resultCount: results.length,
      footerHints: ['←/→ folder'],
      selectActive: (event) => selectResult(results, effectiveActiveIndex, onClose, event),
      selectAlternateActive: () => results[effectiveActiveIndex]?.alternateRun?.(),
      handleKeyDown(event) {
        if (event.key === 'ArrowRight') {
          const result = results[effectiveActiveIndex]
          if (result?.kind !== 'folder' || !result.detail) return false
          event.preventDefault()
          drillIntoFolder(result.detail)
          onActiveChange(0)
          return true
        }
        if (event.key === 'ArrowLeft') {
          const parent = parentPath(browsePath)
          if (!parent) return false
          event.preventDefault()
          drillIntoFolder(parent)
          onActiveChange(0)
          return true
        }
        return false
      },
    })
  }, [effectiveActiveIndex, folderBrowse.data, folderBrowsePlan?.dir, onActiveChange, onClose, results, setScopeApi])

  useLayoutEffect(() => {
    onActiveChange(openFolderFilter && results.length > 1 ? 1 : 0)
  }, [folderBrowse.data, openFolderFilter, onActiveChange, results.length])

  return (
    <UniversalMenuResultList
      results={results}
      activeIndex={activeIndex}
      mouseMoved={mouseMoved}
      onMouseMoved={onMouseMoved}
      onActiveChange={onActiveChange}
      onSelect={(index, event) => void selectResult(results, index, onClose, event)}
      onAlternateSelect={(index) => void results[index]?.alternateRun?.()}
      renderResult={renderFileSystemResult}
      loading={folderBrowse.isFetching}
    />
  )
}

function renderFileSystemResult(result: UniversalMenuResult, state: UniversalMenuRenderState) {
  const detail = result.actionHint ? (state.active ? result.actionHint : undefined) : result.detail
  const depth = result.depth ?? 0
  const isCreateFolder = result.id.startsWith('open-folder-create:')
  return (
    <div className="relative">
      <button
        type="button"
        disabled={state.disabled}
        onMouseEnter={state.onMouseEnter}
        onClick={(event) => state.onSelect(event)}
        className={`${rowClassName(state)} !gap-1.5 ${isCreateFolder ? '!text-neutral-500' : ''}`}
        style={{ paddingLeft: `${16 + depth * 12}px` }}
      >
        {result.kind === 'folder' ? (
          <span
            role={result.drill ? 'button' : undefined}
            aria-label={result.drill ? `Open ${result.label}` : undefined}
            className={`relative z-10 flex w-3 shrink-0 items-center justify-center text-neutral-600 ${result.drill ? 'cursor-pointer hover:text-neutral-300' : ''}`}
            onClick={(event) => {
              if (!result.drill) return
              event.preventDefault()
              event.stopPropagation()
              result.drill()
            }}
          >
            {depth === 0 ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
          </span>
        ) : isCreateFolder ? (
          <span className="relative z-10 flex w-3 shrink-0 items-center justify-center text-neutral-600"><Plus className="h-3.5 w-3.5" aria-hidden="true" /></span>
        ) : result.icon ? (
          <span className="relative z-10"><TabIconView icon={result.icon} /></span>
        ) : (
          <span className="relative z-10 w-3" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">{result.label}</span>
        {detail && <span className="hidden max-w-[44%] truncate text-[11px] text-neutral-500 sm:block">{detail}</span>}
      </button>
    </div>
  )
}

function openFolderScopeResults({ data, error, loading, filter, workspaceId, startChat, openFile, drillFolder, createFolder, openNewWorkspaceChat }: { data?: FolderBrowseData; error: unknown; loading: boolean; filter: string; workspaceId?: string; startChat: (path: string) => Promise<void>; openFile: (path: string) => void; drillFolder: (path: string) => void; createFolder: (parentPath: string, name: string) => Promise<void>; openNewWorkspaceChat: (path: string) => void }): UniversalMenuResult[] {
  if (loading) return [disabledRow('open-folder-loading', 'Loading folders...')]
  if (error) return [disabledRow('open-folder-error', extractTrpcMessage(error))]
  if (!data) return [disabledRow('open-folder-empty', 'No folder data.')]

  const q = filter.trim().toLowerCase()
  const dirs = q ? data.dirs.filter((dir) => dir.name.toLowerCase().includes(q) || dir.path.toLowerCase().includes(q)) : data.dirs
  const files = q ? (data.files ?? []).filter((file) => file.name.toLowerCase().includes(q) || file.path.toLowerCase().includes(q)) : (data.files ?? [])
  const rows: UniversalMenuResult[] = [{ id: `open-folder-current:${data.path}`, kind: 'folder', label: basename(data.path), detail: data.path, actionHint: 'create chat', icon: paneTabIconForType('file'), depth: 0, haystack: data.path, disabled: !workspaceId, run: () => startChat(data.path), alternateRun: () => openNewWorkspaceChat(data.path) }]

  rows.push(...dirs.map((dir): UniversalMenuResult => ({ id: `open-folder-dir:${dir.path}`, kind: 'folder', label: dir.name, detail: dir.path, actionHint: 'create chat', icon: paneTabIconForType('file'), parentId: `open-folder-current:${data.path}`, depth: 1, haystack: `${dir.name} ${dir.path}`, run: () => startChat(dir.path), alternateRun: () => openNewWorkspaceChat(dir.path), drill: () => drillFolder(dir.path) })))
  rows.push(...files.map((file): UniversalMenuResult => ({ id: `open-folder-file:${file.path}`, kind: 'file', label: file.name, detail: file.path, actionHint: 'open file', icon: paneTabIconForType('file'), parentId: `open-folder-current:${data.path}`, depth: 1, haystack: `${file.name} ${file.path}`, run: () => openFile(file.path) })))

  const createName = folderNameToCreate(filter, data.dirs)
  if (createName) rows.push({ id: `open-folder-create:${data.path}/${createName}`, kind: 'action', label: `New folder: ${createName}`, detail: data.path, actionHint: 'create folder', parentId: `open-folder-current:${data.path}`, depth: 1, haystack: `create folder ${createName} ${data.path}`, keepOpen: true, run: () => createFolder(data.path, createName) })
  if (dirs.length === 0 && files.length === 0 && !createName) rows.push(disabledRow('open-folder-no-matches', q ? 'No matching items.' : 'No items.'))
  return rows
}

function folderNameToCreate(filter: string, dirs: FolderBrowseDir[]): string | null {
  const name = filter.trim()
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return null
  const lower = name.toLowerCase()
  if (dirs.some((dir) => dir.name.toLowerCase() === lower)) return null
  return name
}

function isPathLikeInput(value: string): boolean {
  const trimmed = value.trimStart()
  return trimmed.startsWith('~') || trimmed.includes('/')
}

function pathBrowsePlan(value: string, anchors: { home?: string | null; defaultPath?: string | null }): FolderBrowsePlan {
  const trimmed = value.trim()
  const home = anchors.home || undefined
  const defaultPath = anchors.defaultPath || undefined
  let expanded: string
  if (!trimmed) return { dir: undefined, filter: '' }
  if (trimmed === '~') return { dir: home, filter: '' }
  if (trimmed.startsWith('~/')) expanded = home ? `${home}${trimmed.slice(1)}` : trimmed
  else if (trimmed.startsWith('/')) expanded = trimmed
  else {
    const relativeRoot = home ?? defaultPath
    expanded = relativeRoot ? `${relativeRoot.replace(/\/+$/, '')}/${trimmed}` : trimmed
  }
  if (expanded.endsWith('/')) return { dir: expanded, filter: '' }
  const slash = expanded.lastIndexOf('/')
  if (slash < 0) return { dir: defaultPath, filter: expanded }
  if (slash === 0) return { dir: '/', filter: expanded.slice(1) }
  return { dir: expanded.slice(0, slash), filter: expanded.slice(slash + 1) }
}

function pathInputForAbsolutePath(path: string, currentInput: string, anchors: { home?: string | null; defaultPath?: string | null }): string {
  const normalized = path.replace(/\/+$/, '')
  const trimmed = currentInput.trimStart()
  if (trimmed.startsWith('/')) return `${normalized}/`
  const home = anchors.home?.replace(/\/+$/, '')
  if (trimmed.startsWith('~') && home && isPathWithin(normalized, home)) {
    const rel = normalized === home ? '' : normalized.slice(home.length + 1)
    return rel ? `~/${rel}/` : '~/'
  }
  if (home && isPathWithin(normalized, home)) {
    const rel = normalized === home ? '' : normalized.slice(home.length + 1)
    return rel ? `${rel}/` : ''
  }
  const defaultPath = anchors.defaultPath?.replace(/\/+$/, '')
  if (defaultPath && isPathWithin(normalized, defaultPath)) {
    const rel = normalized === defaultPath ? '' : normalized.slice(defaultPath.length + 1)
    return rel ? `${rel}/` : ''
  }
  return `${normalized}/`
}

function isPathWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

function parentPath(path: string | undefined): string | null {
  if (!path) return null
  const normalized = path.replace(/\/+$/, '')
  const slash = normalized.lastIndexOf('/')
  if (slash < 0) return null
  if (slash === 0) return '/'
  return normalized.slice(0, slash)
}
