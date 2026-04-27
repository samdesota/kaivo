import { Link } from '@tanstack/react-router'
import { trpc } from '../trpc'
import { Button, Card, FormError } from '../components/ui'
import { extractTrpcMessage } from '../lib/utils'
import { AddLocalEnvForm } from './local-env-pairing'
import { useState } from 'react'

export function DashboardPage() {
  const [manualPairingOpen, setManualPairingOpen] = useState(false)
  const envs = trpc.env.list.useQuery({}, { refetchInterval: 5_000, refetchOnWindowFocus: true })

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 rounded bg-brand-500" />
          <h1 className="text-lg font-semibold">Local Environment</h1>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/" className="text-sm text-neutral-400 hover:text-neutral-200">
            Workspaces
          </Link>
          <Link to="/settings" className="text-sm text-neutral-400 hover:text-neutral-200">
            Settings
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 p-8">
        <Card className="max-w-none">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="mb-2 text-lg font-medium">Desktop runtime</h2>
              <p className="text-sm text-neutral-500">
                The desktop app starts and pairs its local cc-env automatically. Manual pairing is only needed for browser-only or externally managed envs.
              </p>
            </div>
            <Button
              className="bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
              onClick={() => setManualPairingOpen((open) => !open)}
            >
              {manualPairingOpen ? 'Hide manual pairing' : 'Manual pairing'}
            </Button>
          </div>
          {manualPairingOpen && (
            <div className="mt-5 border-t border-neutral-800 pt-5">
              <AddLocalEnvForm onDone={() => envs.refetch().then(() => undefined)} />
            </div>
          )}
        </Card>

        <section>
          <h2 className="mb-3 text-lg font-medium">Registered local envs</h2>
          {envs.isLoading ? (
            <p className="text-neutral-500">Loading…</p>
          ) : envs.error ? (
            <FormError>{extractTrpcMessage(envs.error)}</FormError>
          ) : envs.data && envs.data.length > 0 ? (
            <ul className="space-y-3">
              {envs.data.map((env) => (
                <li key={env.id}>
                  <Card className="max-w-none">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-lg font-medium text-neutral-100">{env.label}</span>
                          <StatusBadge status={env.status} />
                        </div>
                        <p className="mt-1 text-xs text-neutral-500">
                          {env.id} · {env.url}
                        </p>
                      </div>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-neutral-500">No local env registered yet. If you are in desktop mode, restart the app to auto-pair cc-env.</p>
          )}
        </section>
      </main>
    </div>
  )
}

function StatusBadge({ status }: { status: 'running' | 'archived' | 'crashed' | 'unreachable' }) {
  const map = {
    running: 'bg-emerald-900/60 text-emerald-300',
    archived: 'bg-neutral-800 text-neutral-400',
    crashed: 'bg-red-900/60 text-red-300',
    unreachable: 'bg-amber-900/60 text-amber-300',
  }
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[status]}`}>{status}</span>
}
