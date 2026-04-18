import { useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { trpc } from '../trpc'
import { Button, Card, FormError, Input } from '../components/ui'
import { extractTrpcMessage } from '../lib/utils'

export function DashboardPage() {
  const qc = useQueryClient()
  const logout = trpc.auth.logout.useMutation()
  const list = trpc.sandbox.list.useQuery(undefined, {
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
  })
  const create = trpc.sandbox.create.useMutation()
  const archive = trpc.sandbox.archive.useMutation()
  const del = trpc.sandbox.delete.useMutation()
  const restart = trpc.sandbox.restart.useMutation()

  const [name, setName] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  async function onLogout() {
    await logout.mutateAsync()
    await qc.invalidateQueries()
  }

  async function onCreate(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    const n = name.trim()
    if (!n) return
    try {
      await create.mutateAsync({ name: n })
      setName('')
      await list.refetch()
    } catch (err) {
      setFormError(extractTrpcMessage(err))
    }
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 rounded bg-brand-500" />
          <h1 className="text-lg font-semibold">Cloud Coding Environment</h1>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/settings" className="text-sm text-neutral-400 hover:text-neutral-200">
            Settings
          </Link>
          <Button onClick={onLogout} disabled={logout.isPending}>
            {logout.isPending ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl p-8 space-y-6">
        <section>
          <Card className="max-w-none">
            <h2 className="mb-3 text-lg font-medium">Create a sandbox</h2>
            <form onSubmit={onCreate} className="flex items-start gap-3">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. experiments"
                className="flex-1"
                maxLength={80}
                disabled={create.isPending}
              />
              <Button type="submit" disabled={create.isPending || !name.trim()}>
                {create.isPending ? 'Creating…' : 'Create'}
              </Button>
            </form>
            <div className="mt-3"><FormError>{formError}</FormError></div>
          </Card>
        </section>

        <section>
          <h2 className="mb-3 text-lg font-medium">Sandboxes</h2>
          {list.isLoading ? (
            <p className="text-neutral-500">Loading…</p>
          ) : list.error ? (
            <FormError>{extractTrpcMessage(list.error)}</FormError>
          ) : list.data && list.data.length > 0 ? (
            <ul className="space-y-3">
              {list.data.map((sb) => (
                <li key={sb.id}>
                  <Card className="max-w-none">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <Link
                            to="/sandbox/$id"
                            params={{ id: sb.id }}
                            className="text-lg font-medium text-brand-500 hover:underline"
                          >
                            {sb.name}
                          </Link>
                          <StatusBadge running={sb.running} status={sb.status} />
                        </div>
                        <p className="mt-1 text-xs text-neutral-500">
                          {sb.id} · created {new Date(sb.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {sb.status === 'crashed' && (
                          <Button
                            onClick={() => void restart.mutateAsync({ id: sb.id }).then(() => list.refetch())}
                            disabled={restart.isPending}
                          >
                            Restart
                          </Button>
                        )}
                        {sb.status === 'active' && (
                          <SecondaryButton
                            onClick={() => void archive.mutateAsync({ id: sb.id }).then(() => list.refetch())}
                            disabled={archive.isPending}
                          >
                            Archive
                          </SecondaryButton>
                        )}
                        <DangerButton
                          onClick={() => {
                            if (!confirm(`Delete sandbox "${sb.name}"? This removes its workspace files.`)) return
                            void del.mutateAsync({ id: sb.id }).then(() => list.refetch())
                          }}
                          disabled={del.isPending}
                        >
                          Delete
                        </DangerButton>
                      </div>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-neutral-500">No sandboxes yet. Create one above.</p>
          )}
        </section>
      </main>
    </div>
  )
}

function StatusBadge({ running, status }: { running: boolean; status: 'active' | 'archived' | 'crashed' }) {
  let cls = 'bg-neutral-800 text-neutral-300'
  let label: string = status
  if (status === 'active' && running) {
    cls = 'bg-emerald-900/60 text-emerald-300'
    label = 'running'
  } else if (status === 'active' && !running) {
    cls = 'bg-amber-900/60 text-amber-300'
    label = 'starting'
  } else if (status === 'archived') {
    cls = 'bg-neutral-800 text-neutral-400'
  } else if (status === 'crashed') {
    cls = 'bg-red-900/60 text-red-300'
  }
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{label}</span>
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
