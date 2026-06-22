import { useEffect, useState } from 'react'
import { trpc } from '../../trpc'
import { Button, FormError } from '../../components/ui'
import { openConfirmOverlay, openProviderCredentialsOverlay } from '../../lib/overlay-layer-controller'
import { extractTrpcMessage } from '../../lib/utils'
import { makeEnvClient, type EnvRef } from '../../lib/env-client'
import { SettingsPanel } from './panel'

type ProviderId = 'anthropic' | 'openai' | 'zai'
type EnvOAuthClient = {
  agent: {
    openAIOAuthStatus: { query: () => Promise<{ state: 'idle' | 'pending' | 'connected' | 'failed'; message: string | null }> }
    openAIOAuthStart: { mutate: () => Promise<{ url: string }> }
  }
}

const PROVIDERS: { id: ProviderId; label: string; note: string }[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    note: 'Claude models. Optional base URL for proxies.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    note: 'GPT-compatible models and proxies.',
  },
  {
    id: 'zai',
    label: 'Z.AI Coding Plan',
    note: 'GLM coding models via the Z.AI Coding Plan API key.',
  },
]

export function ProvidersSection() {
  const list = trpc.settings.listProviders.useQuery(undefined, { refetchInterval: 30_000 })
  const envs = trpc.env.list.useQuery({}, { refetchInterval: 10_000 })
  const localEnv = envs.data?.find((env) => env.kind === 'local' && env.status === 'running' && env.envToken)

  return (
    <>
      {list.isLoading ? (
        <SettingsPanel id="providers" title="Providers">
          <p className="text-xs text-neutral-500">Loading…</p>
        </SettingsPanel>
      ) : (
        <>
          {PROVIDERS.map((p) => (
            <ProviderSection
              key={p.id}
              meta={p}
              cfg={list.data?.find((c) => c.provider === p.id) ?? {
                provider: p.id,
                hasApiKey: false,
                hasBaseUrl: false,
                baseUrl: null,
              }}
              onChanged={() => {
                void list.refetch()
              }}
            />
          ))}
          <OpenAIOAuthSection env={localEnv ? {
            id: localEnv.id,
            kind: localEnv.kind,
            url: localEnv.url,
          } : null} envToken={localEnv?.envToken ?? null} />
        </>
      )}
    </>
  )
}

function OpenAIOAuthSection({ env, envToken }: { env: EnvRef | null; envToken: string | null }) {
  const [state, setState] = useState<'idle' | 'pending' | 'connected' | 'failed'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  async function refreshStatus() {
    if (!env || !envToken) return
    const client = makeEnvClient(env, envToken) as unknown as EnvOAuthClient
    const status = await client.agent.openAIOAuthStatus.query()
    setState(status.state)
    setMessage(status.message)
  }

  async function onConnect() {
    if (!env || !envToken) return
    setState('pending')
    setMessage('Starting OpenAI login…')
    try {
      const client = makeEnvClient(env, envToken) as unknown as EnvOAuthClient
      const result = await client.agent.openAIOAuthStart.mutate()
      window.open(result.url, '_blank', 'noopener,noreferrer')
      setMessage('Finish the OpenAI login in the browser window. This page will update automatically.')
      const deadline = Date.now() + 180_000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000))
        const status = await client.agent.openAIOAuthStatus.query()
        setState(status.state)
        setMessage(status.message)
        if (status.state === 'connected' || status.state === 'failed') return
      }
      setState('failed')
      setMessage('Timed out waiting for the OpenAI login callback.')
    } catch (err) {
      setState('failed')
      setMessage(extractTrpcMessage(err))
    }
  }

  return (
    <SettingsPanel
      id="chatgpt-login"
      title="ChatGPT Login"
      description={(
        <span className="inline-flex items-center gap-2">
          <span>Subscription-backed OpenAI models via OpenCode OAuth.</span>
          <StatusPill state={state} />
        </span>
      )}
    >
      <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          <Button onClick={() => void onConnect()} disabled={!env || !envToken || state === 'pending'} className="h-7 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-700">
            {state === 'pending' ? 'Waiting…' : 'Connect'}
          </Button>
          <Button onClick={() => void refreshStatus()} disabled={!env || !envToken || state === 'pending'} className="h-7 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-700">
            Refresh
          </Button>
        </div>
        <p className="text-xs leading-5 text-neutral-600">Tokens are stored in the local OpenCode config for this cc-env.</p>
        {!env && <p className="text-xs text-amber-300">No running local cc-env is available.</p>}
        {message && (
          <p className={state === 'failed' ? 'text-xs text-red-300' : 'text-xs text-neutral-400'}>
            {message}
          </p>
        )}
      </div>
    </SettingsPanel>
  )
}

function ProviderSection({
  meta,
  cfg,
  onChanged,
}: {
  meta: { id: ProviderId; label: string; note: string }
  cfg: { provider: string; hasApiKey: boolean; hasBaseUrl: boolean; baseUrl: string | null }
  onChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const del = trpc.settings.deleteProvider.useMutation()

  useEffect(() => {
    setError(null)
  }, [cfg.baseUrl])

  async function onDelete() {
    setError(null)
    const confirmed = await openConfirmOverlay({
      title: `Delete ${meta.label} key?`,
      message: 'The agent will stop working until a new key is saved.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!confirmed) return
    try {
      await del.mutateAsync({ provider: meta.id })
      onChanged()
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  return (
    <SettingsPanel
      id={`${meta.id}-api`}
      title={`${meta.label} API`}
      description={(
        <span className="inline-flex items-center gap-2">
          <span>{meta.note}</span>
          <StatusPill state={cfg.hasApiKey ? 'connected' : 'idle'} connectedLabel="configured" idleLabel="missing" />
        </span>
      )}
    >
      <div className="space-y-3">
        {cfg.hasApiKey ? (
          <div className="grid max-w-3xl gap-2 text-xs sm:grid-cols-2">
            <div>
              <div className="text-[11px] font-medium text-neutral-500">API key</div>
              <div className="mt-1 font-mono text-neutral-300">••••••••</div>
            </div>
            <div>
              <div className="text-[11px] font-medium text-neutral-500">Base URL</div>
              <div className="mt-1 truncate font-mono text-neutral-300">{cfg.baseUrl || 'Default'}</div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-neutral-500">No credentials saved.</p>
        )}
        <div className="flex gap-1.5">
          <Button
            onClick={() => {
              setError(null)
              void openProviderCredentialsOverlay({
                provider: meta.id,
                label: meta.label,
                hasApiKey: cfg.hasApiKey,
                baseUrl: cfg.baseUrl,
              }).then((saved) => {
                if (saved) onChanged()
              }).catch((err) => setError(extractTrpcMessage(err)))
            }}
            className="h-7 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
          >
            {cfg.hasApiKey ? 'Edit' : 'Add credentials'}
          </Button>
          {cfg.hasApiKey && (
            <Button
              onClick={() => void onDelete()}
              disabled={del.isPending}
              className="h-7 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
            >
              {del.isPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          )}
        </div>
        {error && <FormError>{error}</FormError>}
      </div>
    </SettingsPanel>
  )
}

function StatusPill({
  state,
  connectedLabel = 'connected',
  idleLabel = 'not connected',
}: {
  state: 'idle' | 'pending' | 'connected' | 'failed'
  connectedLabel?: string
  idleLabel?: string
}) {
  return (
    <span
      className={
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] ' +
        (state === 'connected'
          ? 'bg-emerald-900/40 text-emerald-300'
          : state === 'pending'
            ? 'bg-amber-900/40 text-amber-200'
            : state === 'failed'
              ? 'bg-red-950/60 text-red-300'
              : 'bg-neutral-900 text-neutral-500')
      }
    >
      {state === 'connected' ? connectedLabel : state === 'pending' ? 'pending' : state === 'failed' ? 'failed' : idleLabel}
    </span>
  )
}
