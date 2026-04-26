import { useState } from 'react'
import { trpc } from '../trpc'
import { Button, FormError, Input } from '../components/ui'
import { extractTrpcMessage } from '../lib/utils'
import { confirmPairing, getLocalEnvStatus, startPairing } from '../lib/env-client'
import { DEFAULT_LOCAL_ENV_URL } from '../lib/local-env-discovery'

export function AddLocalEnvForm({ onDone }: { onDone: () => Promise<void> }) {
  const [url, setUrl] = useState(DEFAULT_LOCAL_ENV_URL)
  const [label, setLabel] = useState('local')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const register = trpc.env.registerLocal.useMutation()

  async function onStart() {
    setErr(null)
    setBusy(true)
    try {
      const res = await startPairing(url)
      setSessionId(res.sessionId)
      const status = await getLocalEnvStatus(url)
      if (status?.label && label === 'local') setLabel(status.label)
    } catch (e) {
      setErr(extractTrpcMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function onConfirm() {
    if (!sessionId) return
    setErr(null)
    setBusy(true)
    try {
      const status = await getLocalEnvStatus(url)
      if (!status?.label) throw new Error('could not read local env identity label')
      const { envToken } = await confirmPairing(url, sessionId, code.trim())
      await register.mutateAsync({
        url,
        envToken,
        label: label.trim(),
        localIdentityLabel: status.label,
      })
      setSessionId(null)
      setCode('')
      await onDone()
    } catch (e) {
      setErr(extractTrpcMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs text-neutral-500">Env URL</label>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://127.0.0.1:47821"
          disabled={!!sessionId || busy}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-neutral-500">Label</label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="local"
          disabled={!!sessionId || busy}
        />
      </div>

      {!sessionId ? (
        <Button onClick={onStart} disabled={busy || !url || !label}>
          {busy ? 'Requesting pair code…' : 'Request pair code'}
        </Button>
      ) : (
        <>
          <p className="text-sm text-neutral-400">
            Check the cc-env log for the 6-digit pair code, then enter it below. On macOS:{' '}
            <code>tail -f ~/.local/share/cc-env/state/log/cc-env.log</code>
          </p>
          <div>
            <label className="mb-1 block text-xs text-neutral-500">Code</label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              maxLength={12}
              disabled={busy}
            />
          </div>
          <Button onClick={onConfirm} disabled={busy || !code.trim()}>
            {busy ? 'Pairing…' : 'Pair + register'}
          </Button>
        </>
      )}

      <FormError>{err}</FormError>
    </div>
  )
}
