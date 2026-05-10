import { useEffect, useMemo, useState } from 'react'
import { envTrpc } from '../../env-trpc'

export function FileTree({
  onOpen,
  activePath,
}: {
  onOpen: (path: string) => void
  activePath: string | null
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['/']))
  const [version, setVersion] = useState(0)

  envTrpc.fs.watch.useSubscription(
    undefined,
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
  path,
  depth,
  expanded,
  setExpanded,
  onOpen,
  activePath,
  version,
}: {
  path: string
  depth: number
  expanded: Set<string>
  setExpanded: (updater: (prev: Set<string>) => Set<string>) => void
  onOpen: (p: string) => void
  activePath: string | null
  version: number
}) {
  const isOpen = expanded.has(path)

  const q = envTrpc.fs.list.useQuery(
    { path },
    {
      enabled: isOpen,
    },
  )

  useEffect(() => {
    if (isOpen) q.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  const entries = (q.data ?? []) as Entry[]

  if (path === '/') {
    return (
      <ul>
        {entries.map((e) => (
          <li key={e.path}>
            <EntryRow
              entry={e}
              depth={depth}
              expanded={expanded}
              setExpanded={setExpanded}
              onOpen={onOpen}
              activePath={activePath}
              version={version}
            />
          </li>
        ))}
        {q.data && entries.length === 0 && (
          <li className="px-2 py-1 text-xs text-neutral-600">(empty)</li>
        )}
      </ul>
    )
  }

  return isOpen ? (
    <ul>
      {q.isLoading && <li className="px-2 py-1 text-xs text-neutral-600">Loading…</li>}
      {entries.map((e) => (
        <li key={e.path}>
          <EntryRow
            entry={e}
            depth={depth}
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

function EntryRow({
  entry,
  depth,
  expanded,
  setExpanded,
  onOpen,
  activePath,
  version,
}: {
  entry: Entry
  depth: number
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
        (isActive ? 'bg-neutral-900 text-neutral-200' : 'text-neutral-300')
      }
      style={indent}
      onClick={() => onOpen(entry.path)}
    >
      <span className="text-neutral-500">•</span>
      <span className="truncate">{entry.name}</span>
    </button>
  )
}
