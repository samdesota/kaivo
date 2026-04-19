import { useEffect, useState } from 'react'
import { Link, useSearch } from '@tanstack/react-router'
import { trpc } from '../trpc'
import { Button, Card, FormError, Input } from '../components/ui'
import { extractTrpcMessage } from '../lib/utils'
import { ProvidersSection } from './settings/providers'

export function SettingsPage() {
  const search = useSearch({ strict: false }) as { github?: string }
  const status = trpc.github.status.useQuery(undefined, { refetchInterval: 10_000 })
  const connectStart = trpc.github.connectStart.useMutation()
  const disconnect = trpc.github.disconnect.useMutation()
  const [org, setOrg] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (search.github === 'connected') {
      void status.refetch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.github])

  async function onConnect() {
    setError(null)
    try {
      const { redirectUrl } = await connectStart.mutateAsync({
        org: org.trim() || undefined,
      })
      window.location.href = redirectUrl
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  async function onDisconnect() {
    setError(null)
    if (!confirm('Disconnect the GitHub App? This only removes local metadata; uninstall from GitHub separately.')) return
    try {
      await disconnect.mutateAsync()
      await status.refetch()
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-brand-500 hover:underline">
            ← Dashboard
          </Link>
          <h1 className="text-lg font-semibold">Settings</h1>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 p-8">
        <ProvidersSection />

        <Card className="max-w-none">
          <h2 className="mb-1 text-lg font-medium">GitHub integration</h2>
          <p className="mb-4 text-sm text-neutral-400">
            Install a GitHub App into your organization to list repos and clone with short-lived installation tokens.
          </p>
          {status.isLoading ? (
            <p className="text-neutral-500">Loading…</p>
          ) : status.data?.connected ? (
            <div className="space-y-3">
              <div className="rounded border border-neutral-800 bg-neutral-900 p-3 text-sm">
                <div>
                  App:{' '}
                  <span className="font-mono text-neutral-300">
                    {status.data.appSlug ?? 'unknown'}
                  </span>
                </div>
                {status.data.orgLogin && (
                  <div>
                    Org:{' '}
                    <span className="font-mono text-neutral-300">
                      {status.data.orgLogin}
                    </span>
                  </div>
                )}
                <div>
                  Installation:{' '}
                  <span className={status.data.installed ? 'text-emerald-400' : 'text-amber-300'}>
                    {status.data.installed ? 'installed' : 'pending install'}
                  </span>
                </div>
                {status.data.connectedAt && (
                  <div className="text-xs text-neutral-500">
                    connected {new Date(status.data.connectedAt).toLocaleString()}
                  </div>
                )}
              </div>
              {!status.data.installed && status.data.appSlug && (
                <a
                  href={`https://github.com/apps/${status.data.appSlug}/installations/new`}
                  className="inline-flex items-center rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm hover:bg-neutral-800"
                >
                  Install on GitHub →
                </a>
              )}
              <div>
                <Button
                  onClick={() => void onDisconnect()}
                  disabled={disconnect.isPending}
                  className="bg-red-700 hover:bg-red-600"
                >
                  {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-neutral-400">
                Optional: enter your GitHub organization login. Leave blank to install
                under your personal account.
              </p>
              <div className="flex gap-2">
                <Input
                  value={org}
                  onChange={(e) => setOrg(e.target.value)}
                  placeholder="acme-inc"
                  className="flex-1"
                  maxLength={39}
                />
                <Button onClick={() => void onConnect()} disabled={connectStart.isPending}>
                  {connectStart.isPending ? 'Redirecting…' : 'Connect GitHub'}
                </Button>
              </div>
            </div>
          )}
          {error && (
            <div className="mt-3">
              <FormError>{error}</FormError>
            </div>
          )}
        </Card>
      </main>
    </div>
  )
}
