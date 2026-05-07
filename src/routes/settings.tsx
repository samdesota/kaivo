import { useEffect, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { trpc } from '../trpc'
import { trpcQueryKey } from '../lib/trpc-plain'
import { Button, FormError, Input } from '../components/ui'
import { openConfirmOverlay } from '../lib/overlay-layer-controller'
import { extractTrpcMessage } from '../lib/utils'
import { ProvidersSection } from './settings/providers'
import { FONT_SIZE_BOUNDS, useFontSize } from '../lib/ui-prefs'
import { RepoConfigCreateButton, RepoConfigsManager } from './repo-config-manager'
import { SettingsPanel } from './settings/panel'

type SettingsPageId = 'agent' | 'repos' | 'appearance'

const SETTINGS_PAGES: { id: SettingsPageId; label: string; description: string }[] = [
  { id: 'agent', label: 'Agent', description: 'Models, providers, and agent credentials.' },
  { id: 'repos', label: 'Repos', description: 'Repository templates and GitHub integration.' },
  { id: 'appearance', label: 'Appearance', description: 'Local interface preferences.' },
]

export function SettingsPage() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { github?: string; page?: string }
  const [activePage, setActivePage] = useState<SettingsPageId>(() => parseSettingsPage(search.page))
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

  useEffect(() => {
    setActivePage(parseSettingsPage(search.page))
  }, [search.page])

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
    const confirmed = await openConfirmOverlay({
      title: 'Disconnect GitHub App?',
      message: 'This only removes local metadata; uninstall from GitHub separately.',
      confirmLabel: 'Disconnect',
      destructive: true,
    })
    if (!confirmed) return
    try {
      await disconnect.mutateAsync()
      await status.refetch()
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  return (
    <div className="flex h-screen max-h-screen w-screen overflow-hidden bg-neutral-975 text-neutral-100">
      <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
        <div className="window-drag flex flex-none basis-8 items-center border-b border-neutral-800 px-3">
          <button
            onClick={() => void navigate({ to: '..' })}
            className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200"
          >
            Back
          </button>
        </div>
        <div className="px-3 py-3">
          <h1 className="text-xs font-medium text-neutral-300">Settings</h1>
          <p className="mt-1 text-[11px] leading-4 text-neutral-600">Configure Cloud Code.</p>
        </div>
        <nav className="flex-1 px-2 text-xs text-neutral-500">
          <div className="space-y-1">
            {SETTINGS_PAGES.map((page) => (
              <button
                key={page.id}
                onClick={() => setActivePage(page.id)}
                className={
                  'block w-full rounded px-2 py-1.5 text-left transition-colors ' +
                  (activePage === page.id ? 'bg-neutral-900 text-neutral-100' : 'hover:bg-neutral-900 hover:text-neutral-200')
                }
              >
                {page.label}
              </button>
            ))}
          </div>
        </nav>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto bg-neutral-975 px-5 py-5">
        <div className="mx-auto max-w-5xl space-y-3">
          <div className="mb-4">
            <h2 className="text-xl font-semibold tracking-tight text-neutral-100">{SETTINGS_PAGES.find((page) => page.id === activePage)?.label}</h2>
            <p className="mt-1 text-xs text-neutral-500">{SETTINGS_PAGES.find((page) => page.id === activePage)?.description}</p>
          </div>
          {activePage === 'agent' && (
            <>
              <AgentDefaultModelSection />
              <ProvidersSection />
            </>
          )}
          {activePage === 'repos' && (
            <>
              <SettingsPanel
                id="repo-configs"
                title="Repo configs"
                action={<RepoConfigCreateButton />}
                description={(
                  <>
                    Reusable clone templates with encrypted files like <span className="font-mono">.env</span>.
                  </>
                )}
              >
                <RepoConfigsManager />
              </SettingsPanel>
              <SettingsPanel
                id="github"
                title="GitHub"
                description="Install a GitHub App to list repos and clone with short-lived installation tokens."
              >
          {status.isLoading ? (
            <p className="text-xs text-neutral-500">Loading…</p>
          ) : status.data?.connected ? (
            <div className="space-y-3">
              <div className="rounded border border-neutral-800 bg-neutral-900/50 p-3 text-xs text-neutral-400">
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
                  className="inline-flex items-center rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
                >
                  Install on GitHub →
                </a>
              )}
              <div>
                <Button
                  onClick={() => void onDisconnect()}
                  disabled={disconnect.isPending}
                  className="bg-red-700 px-2.5 py-1.5 text-xs hover:bg-red-600"
                >
                  {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-neutral-500">
                Optional: enter your GitHub organization login. Leave blank to install
                under your personal account.
              </p>
              <div className="flex gap-2">
                <Input
                  value={org}
                  onChange={(e) => setOrg(e.target.value)}
                  placeholder="acme-inc"
                  className="flex-1 py-1.5 text-xs"
                  maxLength={39}
                />
                <Button onClick={() => void onConnect()} disabled={connectStart.isPending} className="bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700">
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
              </SettingsPanel>
            </>
          )}
          {activePage === 'appearance' && <AppearanceSection />}
        </div>
      </main>
    </div>
  )
}

function parseSettingsPage(page: string | undefined): SettingsPageId {
  return page === 'repos' || page === 'appearance' ? page : 'agent'
}

function AgentDefaultModelSection() {
  const current = trpc.agent.defaultModelGet.useQuery()
  const save = trpc.agent.defaultModelSet.useMutation()
  const queryClient = useQueryClient()
  const [model, setModel] = useState('openai/gpt-5.5')
  const [savedModel, setSavedModel] = useState('openai/gpt-5.5')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!current.data) return
    const nextModel = `${current.data.providerID}/${current.data.modelID}`
    setModel(nextModel)
    setSavedModel(nextModel)
  }, [current.data])

  async function onSave() {
    setError(null)
    const [providerID = '', ...modelParts] = model.trim().split('/')
    const modelID = modelParts.join('/')
    try {
      await save.mutateAsync({ providerID: providerID.trim(), modelID: modelID.trim() })
      await queryClient.invalidateQueries({ queryKey: trpcQueryKey('agent.defaultModelGet') })
      setSavedModel(model.trim())
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  return (
    <SettingsPanel
      id="agent-model"
      title="Default model"
      description={<>Used for new messages when a chat has no model override. Built-in default: <span className="font-mono">openai/gpt-5.5</span>.</>}
    >
      <div className="max-w-xl space-y-2">
        <Input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="openai/gpt-5.5"
          className="h-7 px-2 py-1 font-mono text-xs"
          maxLength={300}
        />
        {model.trim() !== savedModel && <div>
            <Button
              onClick={() => void onSave()}
              disabled={save.isPending || !model.trim().includes('/') || model.trim().endsWith('/')}
              className="h-7 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
            >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>}
      </div>
      {current.isLoading && <p className="mt-2 text-xs text-neutral-500">Loading current default…</p>}
      {error && (
        <div className="mt-3">
          <FormError>{error}</FormError>
        </div>
      )}
    </SettingsPanel>
  )
}

function AppearanceSection() {
  const [size, setSize] = useFontSize()
  return (
    <SettingsPanel id="appearance" title="Appearance" description="Base font size is saved per-browser.">
      <label className="flex items-center gap-3 text-xs">
        <span className="w-24 text-neutral-400">Font size</span>
        <input
          type="range"
          min={FONT_SIZE_BOUNDS.min}
          max={FONT_SIZE_BOUNDS.max}
          step={1}
          value={size}
          onChange={(e) => setSize(Number(e.target.value))}
          className="flex-1"
        />
        <span className="w-14 text-right font-mono text-neutral-300">{size}px</span>
        <button
          onClick={() => setSize(FONT_SIZE_BOUNDS.default)}
          className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          Reset
        </button>
      </label>
    </SettingsPanel>
  )
}
