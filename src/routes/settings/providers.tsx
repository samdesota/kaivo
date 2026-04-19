import { useState } from 'react'
import { trpc } from '../../trpc'
import { Button, Card, FormError, Input, Label } from '../../components/ui'
import { extractTrpcMessage } from '../../lib/utils'

type ProviderId = 'anthropic' | 'openai'

const PROVIDERS: { id: ProviderId; label: string; note: string }[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    note: 'Claude (sonnet, opus, haiku). Base URL optional for self-hosted proxies (LiteLLM, etc.).',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    note: 'GPT family. Base URL optional for compatible providers.',
  },
]

export function ProvidersSection() {
  const list = trpc.settings.listProviders.useQuery(undefined, { refetchInterval: 30_000 })

  return (
    <Card className="max-w-none">
      <h2 className="mb-1 text-lg font-medium">AI provider keys</h2>
      <p className="mb-4 text-sm text-neutral-400">
        Keys are stored encrypted on disk. The built-in agent (OpenCode) uses
        these to talk to the provider from inside each sandbox.
      </p>
      {list.isLoading ? (
        <p className="text-neutral-500">Loading…</p>
      ) : (
        <div className="space-y-6">
          {PROVIDERS.map((p) => (
            <ProviderRow
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
        </div>
      )}
    </Card>
  )
}

function ProviderRow({
  meta,
  cfg,
  onChanged,
}: {
  meta: { id: ProviderId; label: string; note: string }
  cfg: { provider: string; hasApiKey: boolean; hasBaseUrl: boolean; baseUrl: string | null }
  onChanged: () => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl ?? '')
  const [error, setError] = useState<string | null>(null)
  const setKey = trpc.settings.setProviderKey.useMutation()
  const setBase = trpc.settings.setProviderBaseUrl.useMutation()
  const del = trpc.settings.deleteProvider.useMutation()

  async function onSave() {
    setError(null)
    try {
      if (apiKey.trim()) {
        await setKey.mutateAsync({
          provider: meta.id,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || null,
        })
      } else {
        await setBase.mutateAsync({
          provider: meta.id,
          baseUrl: baseUrl.trim() || null,
        })
      }
      setApiKey('')
      onChanged()
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  async function onDelete() {
    setError(null)
    if (!confirm(`Delete the ${meta.label} key? The agent will stop working until a new key is saved.`)) return
    try {
      await del.mutateAsync({ provider: meta.id })
      setApiKey('')
      setBaseUrl('')
      onChanged()
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-neutral-100">{meta.label}</div>
          <div className="text-xs text-neutral-500">{meta.note}</div>
        </div>
        <span
          className={
            'rounded px-2 py-0.5 text-xs ' +
            (cfg.hasApiKey
              ? 'bg-emerald-900/40 text-emerald-300'
              : 'bg-neutral-800 text-neutral-400')
          }
        >
          {cfg.hasApiKey ? 'configured' : 'not configured'}
        </span>
      </div>
      <div className="space-y-3">
        <div>
          <Label htmlFor={`${meta.id}-key`}>API key</Label>
          <Input
            id={`${meta.id}-key`}
            type="password"
            autoComplete="off"
            placeholder={cfg.hasApiKey ? '•••••••• (stored; enter new value to rotate)' : 'sk-…'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor={`${meta.id}-base`}>Base URL (optional)</Label>
          <Input
            id={`${meta.id}-base`}
            type="url"
            placeholder="https://api.anthropic.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <p className="mt-1 text-xs text-neutral-500">
            For local proxies, use <code className="font-mono">http://localhost:&lt;port&gt;</code>.
            It gets rewritten to <code className="font-mono">host.docker.internal</code> inside the
            sandbox automatically.
          </p>
        </div>
        {error && <FormError>{error}</FormError>}
        <div className="flex gap-2">
          <Button
            onClick={() => void onSave()}
            disabled={setKey.isPending || setBase.isPending || (!apiKey.trim() && baseUrl === (cfg.baseUrl ?? ''))}
          >
            {setKey.isPending || setBase.isPending ? 'Saving…' : 'Save'}
          </Button>
          {cfg.hasApiKey && (
            <Button
              onClick={() => void onDelete()}
              disabled={del.isPending}
              className="bg-red-700 hover:bg-red-600"
            >
              {del.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
