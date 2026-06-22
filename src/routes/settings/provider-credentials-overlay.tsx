import { useState } from 'react'
import { trpc } from '../../trpc'
import { Button, FormError, Input, Modal } from '../../components/ui'
import { extractTrpcMessage } from '../../lib/utils'

type ProviderId = 'anthropic' | 'openai' | 'zai'

export function ProviderCredentialsOverlay({
  provider,
  label,
  hasApiKey,
  baseUrl: initialBaseUrl,
  onClose,
  onSaved,
}: {
  provider: ProviderId
  label: string
  hasApiKey: boolean
  baseUrl: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl ?? '')
  const [error, setError] = useState<string | null>(null)
  const setKey = trpc.settings.setProviderKey.useMutation()
  const setBase = trpc.settings.setProviderBaseUrl.useMutation()

  async function onSave() {
    setError(null)
    try {
      if (apiKey.trim()) {
        await setKey.mutateAsync({
          provider,
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim() || null,
        })
      } else {
        await setBase.mutateAsync({
          provider,
          baseUrl: baseUrl.trim() || null,
        })
      }
      onSaved()
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  const busy = setKey.isPending || setBase.isPending

  return (
    <Modal open onClose={onClose} title={`${hasApiKey ? 'Edit' : 'Add'} ${label} credentials`} widthClass="max-w-lg">
      <div>
        <label className="mb-3 block">
          <span className="block text-[11px] font-medium text-neutral-400">API key</span>
          <Input
            id={`${provider}-key`}
            type="password"
            autoComplete="off"
            placeholder={hasApiKey ? 'Stored. Enter a new value to rotate.' : 'sk-...'}
            value={apiKey}
            className="mt-1 h-7 px-2 py-1 text-xs"
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="block text-[11px] font-medium text-neutral-400">Base URL</span>
          <Input
            id={`${provider}-base`}
            type="url"
            placeholder="Default provider URL"
            value={baseUrl}
            className="mt-1 h-7 px-2 py-1 text-xs"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        {error && <div className="mt-3"><FormError>{error}</FormError></div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose} className="h-7 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-700">
            Cancel
          </Button>
          <Button
            onClick={() => void onSave()}
            disabled={busy || (!apiKey.trim() && !hasApiKey)}
            className="h-7 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-200 hover:bg-neutral-700"
          >
            {busy ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
