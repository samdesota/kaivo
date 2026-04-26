import { Link } from '@tanstack/react-router'
import { trpc } from '../trpc'
import { Card, FormError } from '../components/ui'
import { extractTrpcMessage } from '../lib/utils'
import { useLocalEnvIdentity } from '../lib/local-env-discovery'
import { AddLocalEnvForm } from './local-env-pairing'

export function DashboardPage() {
  const localIdentity = useLocalEnvIdentity()
  const envs = trpc.env.list.useQuery(
    localIdentity.label ? { localIdentityLabel: localIdentity.label } : {},
    { refetchInterval: 5_000, refetchOnWindowFocus: true },
  )

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
          <h2 className="mb-2 text-lg font-medium">Pair local env</h2>
          <p className="mb-4 text-sm text-neutral-500">
            Register the local cc-env process so workspaces can run agents and shells on this machine.
          </p>
          <AddLocalEnvForm onDone={() => envs.refetch().then(() => undefined)} />
        </Card>

        <section>
          <h2 className="mb-3 text-lg font-medium">Registered local envs</h2>
          {localIdentity.loading || envs.isLoading ? (
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
            <p className="text-neutral-500">No local env registered yet.</p>
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
