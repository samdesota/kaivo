import { useEffect, useMemo, useState } from 'react'
import { trpc } from '../../trpc'

export function FileTree({
  sandboxId,
  onOpen,
  activePath,
}: {
  sandboxId: string
  onOpen: (path: string) => void
  activePath: string | null
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['/']))
  const [version, setVersion] = useState(0)

  // Subscribe to fs changes; bump `version` to invalidate dir queries.
  trpc.fs.watch.useSubscription(
    { sandboxId },
    {
      onData() {
        setVersion((v) => v + 1)
      },
    },
  )

  return (
    <div className="p-2 text-sm">
      <div className="mb-2 px-2 text-xs uppercase tracking-wide text-neutral-500">Files</div>
      <DirNode
        sandboxId={sandboxId}
        path="/"
        depth={0}
        expanded={expanded}
        setExpanded={setExpanded}
        onOpen={onOpen}
        activePath={activePath}
        version={version}
      />
    </div>
  )
}

function DirNode({
  sandboxId,
  path,
  depth,
  expanded,
  setExpanded,
  onOpen,
  activePath,
  version,
}: {
  sandboxId: string
  path: string
  depth: number
  expanded: Set<string>
  setExpanded: (updater: (prev: Set<string>) => Set<string>) => void
  onOpen: (p: string) => void
  activePath: string | null
  version: number
}) {
  const isOpen = expanded.has(path)

  const q = trpc.fs.list.useQuery(
    { sandboxId, path },
    {
      enabled: isOpen,
      // `version` is in the key via a manual remount below.
    },
  )

  // When version bumps, refetch expanded dirs.
  useEffect(() => {
    if (isOpen) q.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  if (path === '/') {
    return (
      <ul>
        {q.data?.map((e) => (
          <li key={e.path}>
            <Entry
              entry={e}
              depth={depth}
              sandboxId={sandboxId}
              expanded={expanded}
              setExpanded={setExpanded}
              onOpen={onOpen}
              activePath={activePath}
              version={version}
            />
          </li>
        ))}
        {q.data && q.data.length === 0 && (
          <li className="px-2 py-1 text-xs text-neutral-600">(empty)</li>
        )}
      </ul>
    )
  }

  return isOpen ? (
    <ul>
      {q.isLoading && <li className="px-2 py-1 text-xs text-neutral-600">Loading…</li>}
      {q.data?.map((e) => (
        <li key={e.path}>
          <Entry
            entry={e}
            depth={depth}
            sandboxId={sandboxId}
            expanded={expanded}
            setExpanded={setExpanded}
            onOpen={onOpen}
            activePath={activePath}
            version={version}
          />
        </li>
      ))}
    </ul>
  ) : null
}

interface Entry {
  name: string
  path: string
  kind: 'file' | 'directory' | 'symlink' | 'other'
  size: number | null
  mtime: Date | null
}

function Entry({
  entry,
  depth,
  sandboxId,
  expanded,
  setExpanded,
  onOpen,
  activePath,
  version,
}: {
  entry: Entry
  depth: number
  sandboxId: string
  expanded: Set<string>
  setExpanded: (updater: (prev: Set<string>) => Set<string>) => void
  onOpen: (p: string) => void
  activePath: string | null
  version: number
}) {
  const indent = useMemo(() => ({ paddingLeft: depth * 12 + 8 }), [depth])
  const isActive = activePath === entry.path

  if (entry.kind === 'directory') {
    const isOpen = expanded.has(entry.path)
    return (
      <>
        <button
          className="flex w-full items-center gap-1 rounded px-2 py-0.5 text-left text-sm text-neutral-200 hover:bg-neutral-900"
          style={indent}
          onClick={() =>
            setExpanded((prev) => {
              const next = new Set(prev)
              if (next.has(entry.path)) next.delete(entry.path)
              else next.add(entry.path)
              return next
            })
          }
        >
          <span className="text-neutral-500">{isOpen ? '▾' : '▸'}</span>
          <span className="truncate">{entry.name}</span>
        </button>
        {isOpen && (
          <DirNode
            sandboxId={sandboxId}
            path={entry.path}
            depth={depth + 1}
            expanded={expanded}
            setExpanded={setExpanded}
            onOpen={onOpen}
            activePath={activePath}
            version={version}
          />
        )}
      </>
    )
  }
  return (
    <button
      className={
        'flex w-full items-center gap-2 rounded px-2 py-0.5 text-left text-sm hover:bg-neutral-900 ' +
        (isActive ? 'bg-neutral-900 text-brand-500' : 'text-neutral-300')
      }
      style={indent}
      onClick={() => onOpen(entry.path)}
    >
      <span className="text-neutral-500">•</span>
      <span className="truncate">{entry.name}</span>
    </button>
  )
}
