import { useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { trpc } from '../trpc'
import { Button, Card, FormError, Input } from '../components/ui'
import { extractTrpcMessage } from '../lib/utils'
import { setEnvToken, clearEnvToken, getEnvToken } from '../lib/env-tokens'
import { confirmPairing, getLocalEnvStatus, resolveEnvUrl, startPairing } from '../lib/env-client'
import { DEFAULT_LOCAL_ENV_URL, useLocalEnvIdentity } from '../lib/local-env-discovery'

type EnvListItem = {
  id: string
  envToken: string | null
}

export function EnvironmentsSection() {
  const localIdentity = useLocalEnvIdentity()
  const list = trpc.env.list.useQuery(localIdentity.label ? { localIdentityLabel: localIdentity.label } : {}, {
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  })
  const createContainer = trpc.env.createContainer.useMutation()
  const archive = trpc.env.archive.useMutation()
  const del = trpc.env.delete.useMutation()
  const restart = trpc.env.restart.useMutation()
  const unregister = trpc.env.unregister.useMutation()

  const [newLabel, setNewLabel] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [addLocalOpen, setAddLocalOpen] = useState(false)

  async function onCreateContainer(e: FormEvent) {
    e.preventDefault()
    setCreateError(null)
    const label = newLabel.trim()
    if (!label) return
    try {
      const result = await createContainer.mutateAsync({ label })
      setEnvToken(result.env.id, result.envToken)
      setNewLabel('')
      await list.refetch()
    } catch (err) {
      setCreateError(extractTrpcMessage(err))
    }
  }

  async function onArchive(id: string) {
    if (!confirm('Archive this env? Its container stops but workspace files are kept.')) return
    await archive.mutateAsync({ id })
    await list.refetch()
  }

  async function onDelete(id: string, label: string, kind: string) {
    const msg =
      kind === 'local'
        ? `Unregister local env "${label}"? The cc-env process on the local machine will keep running.`
        : `Delete container env "${label}"? This removes its workspace files.`
    if (!confirm(msg)) return
    if (kind === 'local') {
      await unregister.mutateAsync({ id })
    } else {
      await del.mutateAsync({ id })
    }
    clearEnvToken(id)
    await list.refetch()
  }

  async function onRestart(id: string) {
    await restart.mutateAsync({ id })
    await list.refetch()
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-medium">Environments</h2>
      </div>

      <Card className="mb-4 max-w-none">
        <h3 className="mb-3 text-sm font-medium text-neutral-300">New container env</h3>
        <form onSubmit={onCreateContainer} className="flex items-start gap-3">
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="label (e.g. experiments)"
            className="flex-1"
            maxLength={80}
            disabled={createContainer.isPending}
          />
          <Button
            type="submit"
            disabled={createContainer.isPending || !newLabel.trim()}
          >
            {createContainer.isPending ? 'Creating…' : 'Create'}
          </Button>
          <Button type="button" onClick={() => setAddLocalOpen((v) => !v)}>
            {addLocalOpen ? 'Cancel' : 'Add local env'}
          </Button>
        </form>
        <div className="mt-3">
          <FormError>{createError}</FormError>
        </div>
        {addLocalOpen && (
          <div className="mt-4 border-t border-neutral-800 pt-4">
            <AddLocalEnvForm
              onDone={async () => {
                setAddLocalOpen(false)
                await list.refetch()
              }}
            />
          </div>
        )}
      </Card>

      {list.isLoading ? (
        <p className="text-neutral-500">Loading…</p>
      ) : list.error ? (
        <FormError>{extractTrpcMessage(list.error)}</FormError>
      ) : list.data && list.data.length > 0 ? (
        <ul className="space-y-3">
          {list.data.map((env) => (
            <li key={env.id}>
              <Card className="max-w-none">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <Link
                        to="/env/$id"
                        params={{ id: env.id }}
                        className="text-lg font-medium text-brand-500 hover:underline"
                      >
                        {env.label}
                      </Link>
                      <KindBadge kind={env.kind} />
                      <StatusBadge status={env.status} />
                      <TokenBadge env={env} />
                    </div>
                    <p className="mt-1 text-xs text-neutral-500">
                      {env.id} · {env.url}
                    </p>
                    {env.lastSeenAt && (
                      <p className="text-xs text-neutral-600">
                        last seen {new Date(env.lastSeenAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {env.kind === 'container' && env.status !== 'archived' && (
                      <SecondaryButton
                        onClick={() => void onRestart(env.id)}
                        disabled={restart.isPending}
                      >
                        Restart
                      </SecondaryButton>
                    )}
                    {env.kind === 'container' && env.status !== 'archived' && (
                      <SecondaryButton
                        onClick={() => void onArchive(env.id)}
                        disabled={archive.isPending}
                      >
                        Archive
                      </SecondaryButton>
                    )}
                    <DangerButton
                      onClick={() => void onDelete(env.id, env.label, env.kind)}
                      disabled={del.isPending || unregister.isPending}
                    >
                      {env.kind === 'local' ? 'Unregister' : 'Delete'}
                    </DangerButton>
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-neutral-500">
          No envs yet. Create a container env above, or run{' '}
          <code className="text-neutral-400">scripts/install.sh</code> and{' '}
          click &quot;Add local env&quot;.
        </p>
      )}
    </section>
  )
}

function AddLocalEnvForm({ onDone }: { onDone: () => Promise<void> }) {
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
      // Register the env with the orchestrator.
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
            Check the cc-env log for the 6-digit pair code, then enter it
            below. On macOS:{' '}
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

function KindBadge({ kind }: { kind: 'container' | 'local' }) {
  const cls =
    kind === 'container'
      ? 'bg-sky-900/60 text-sky-300'
      : 'bg-violet-900/60 text-violet-300'
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {kind}
    </span>
  )
}

function StatusBadge({
  status,
}: {
  status: 'running' | 'archived' | 'crashed' | 'unreachable'
}) {
  const map = {
    running: 'bg-emerald-900/60 text-emerald-300',
    archived: 'bg-neutral-800 text-neutral-400',
    crashed: 'bg-red-900/60 text-red-300',
    unreachable: 'bg-amber-900/60 text-amber-300',
  }
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[status]}`}
    >
      {status}
    </span>
  )
}

function TokenBadge({ env }: { env: EnvListItem }) {
  const has = env.envToken !== null || getEnvToken(env.id) !== null
  if (has) return null
  return (
    <span className="rounded-full bg-amber-900/60 px-2 py-0.5 text-xs font-medium text-amber-300">
      no token
    </span>
  )
}

function SecondaryButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = '', ...rest } = props
  return (
    <button
      {...rest}
      className={
        'inline-flex items-center justify-center rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm font-medium text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 ' +
        className
      }
    />
  )
}
function DangerButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = '', ...rest } = props
  return (
    <button
      {...rest}
      className={
        'inline-flex items-center justify-center rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-50 ' +
        className
      }
    />
  )
}

// resolveEnvUrl is imported for future /env/:id wiring.
export { resolveEnvUrl }
