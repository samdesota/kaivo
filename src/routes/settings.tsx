import { useEffect, useState } from 'react'
import { Link, useSearch } from '@tanstack/react-router'
import { trpc } from '../trpc'
import { Button, Card, FormError, Input } from '../components/ui'
import { extractTrpcMessage } from '../lib/utils'
import { ProvidersSection } from './settings/providers'
import { FONT_SIZE_BOUNDS, useFontSize } from '../lib/ui-prefs'
import { RepoConfigsManager } from './sandbox/repo-config-manager'

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
        <AppearanceSection />

        <ProvidersSection />

        <AgentDefaultModelSection />

        <Card className="max-w-none">
          <h2 className="mb-1 text-lg font-medium">Repo configs</h2>
          <p className="mb-4 text-sm text-neutral-400">
            Reusable templates for cloning a repo into any sandbox. Attach
            files (typically <span className="font-mono">.env</span>) that
            should be placed into the workspace after the clone completes.
            File contents are encrypted at rest.
          </p>
          <RepoConfigsManager />
        </Card>

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

function AgentDefaultModelSection() {
  const current = trpc.agent.defaultModelGet.useQuery()
  const save = trpc.agent.defaultModelSet.useMutation()
  const utils = trpc.useUtils()
  const [providerID, setProviderID] = useState('openai')
  const [modelID, setModelID] = useState('gpt-5.5')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!current.data) return
    setProviderID(current.data.providerID)
    setModelID(current.data.modelID)
  }, [current.data])

  async function onSave() {
    setError(null)
    try {
      await save.mutateAsync({ providerID: providerID.trim(), modelID: modelID.trim() })
      await utils.agent.defaultModelGet.invalidate()
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  return (
    <Card className="max-w-none">
      <h2 className="mb-1 text-lg font-medium">Agent default model</h2>
      <p className="mb-4 text-sm text-neutral-400">
        Used for new messages when a session has no model override. The built-in default is <span className="font-mono">openai/gpt-5.5</span>.
      </p>
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
        <Input
          value={providerID}
          onChange={(e) => setProviderID(e.target.value)}
          placeholder="openai"
          maxLength={100}
        />
        <Input
          value={modelID}
          onChange={(e) => setModelID(e.target.value)}
          placeholder="gpt-5.5"
          maxLength={200}
        />
        <Button
          onClick={() => void onSave()}
          disabled={save.isPending || !providerID.trim() || !modelID.trim()}
        >
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {current.isLoading && <p className="mt-2 text-xs text-neutral-500">Loading current default…</p>}
      {error && (
        <div className="mt-3">
          <FormError>{error}</FormError>
        </div>
      )}
    </Card>
  )
}

function AppearanceSection() {
  const [size, setSize] = useFontSize()
  return (
    <Card className="max-w-none">
      <h2 className="mb-1 text-lg font-medium">Appearance</h2>
      <p className="mb-4 text-sm text-neutral-400">
        Base font size scales every text-*/p-* utility in the UI. Saved per-browser.
      </p>
      <label className="flex items-center gap-3 text-sm">
        <span className="w-28 text-neutral-400">Font size</span>
        <input
          type="range"
          min={FONT_SIZE_BOUNDS.min}
          max={FONT_SIZE_BOUNDS.max}
          step={1}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          className="flex-1"
        />
        <span className="w-16 text-right font-mono text-neutral-300">{size}px</span>
        <button
          onClick={() => setSize(FONT_SIZE_BOUNDS.default)}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          Reset
        </button>
      </label>
    </Card>
  )
}
