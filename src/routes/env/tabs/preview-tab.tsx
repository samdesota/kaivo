import { useState } from 'react'
import { useEnv } from '../env-context'

/**
 * Previews inside the env server's host: the env-server runs on a host that
 * owns the listening port. For local envs we iframe the raw loopback URL;
 * for container envs we don't yet have a preview reverse proxy, so show a
 * note instead of a broken iframe.
 */
export function PreviewTabContent({ port }: { port: number }) {
  const [key, setKey] = useState(0)
  const { env } = useEnv()

  if (env.kind !== 'local') {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">
        Preview proxy for container envs is not wired up yet. Use{' '}
        <code className="mx-1 rounded bg-neutral-800 px-1 py-0.5 font-mono text-xs">
          ssh -L
        </code>{' '}
        to forward port {port} locally.
      </div>
    )
  }

  // Local env URL shape is `http://127.0.0.1:<envPort>`. The preview service
  // lives on the same host as cc-env, so strip the port and hit the preview
  // port directly. Most dev servers bind to localhost, which is the same
  // loopback address from the browser's POV.
  const origin = new URL(env.url)
  const src = `${origin.protocol}//${origin.hostname}:${port}/`

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
