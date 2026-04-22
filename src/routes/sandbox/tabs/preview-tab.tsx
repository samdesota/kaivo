import { useState } from 'react'
import { trpc } from '../../../trpc'

export function PreviewTabContent({
  sandboxId,
  port,
}: {
  sandboxId: string
  port: number
}) {
  const [key, setKey] = useState(0)
  const config = trpc.preview.config.useQuery(undefined, {
    staleTime: Infinity,
  })
  const src = config.data?.hostname
    ? `${window.location.protocol}//${sandboxId}-${port}.${config.data.hostname}/`
    : `/preview/${sandboxId}/${port}/`

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-3 py-1.5 text-xs">
        <span className="font-mono text-neutral-300">preview :{port}</span>
        <button
          onClick={() => setKey((k) => k + 1)}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 hover:bg-neutral-800"
        >
          reload
        </button>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 hover:bg-neutral-800"
        >
          open
        </a>
      </div>
      <iframe
        key={key}
        src={src}
        title={`preview :${port}`}
        className="flex-1 bg-white"
        sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
      />
    </div>
  )
}
