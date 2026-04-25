import { useEffect, useState } from 'react'
import { Link, useSearch } from '@tanstack/react-router'
import { trpc } from '../trpc'
import { Button, Card, FormError } from '../components/ui'
import { extractTrpcMessage } from '../lib/utils'

/**
 * Confirmation landing page for the install.sh device flow. The CLI shows
 * the user this URL with a `?code=XXXX-XXXX`; after the user clicks
 * Approve, the install.sh poll loop on the other side picks up the
 * identityToken and finishes setup.
 */
export function EnvAuthDevicePage() {
  const search = useSearch({ from: '/envauth/device' }) as { code?: string }
  const [code, setCode] = useState((search.code ?? '').trim())
  const [done, setDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const confirm = trpc.envAuth.deviceConfirm.useMutation()

  // Keep the input in sync if the URL changes.
  useEffect(() => {
    setCode((search.code ?? '').trim())
  }, [search.code])

  async function onApprove() {
    setErr(null)
    const c = code.trim().toUpperCase()
    if (!c) {
      setErr('Enter the code shown by the install script.')
      return
    }
    try {
      await confirm.mutateAsync({ userCode: c })
      setDone(true)
    } catch (e) {
      setErr(extractTrpcMessage(e))
    }
  }

  return (
    <div className="min-h-screen bg-neutral-950 p-6 text-neutral-100">
      <div className="mx-auto max-w-md space-y-4">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold">Pair a local environment</h1>
          <p className="text-sm text-neutral-400">
            Approve the code shown by your local <code>cc-env</code> install
            script. Anyone with this code can mint an identity token for
            your account, so only approve codes you started yourself.
          </p>
        </header>

        <Card className="max-w-none">
          {done ? (
            <div className="space-y-3">
              <div className="rounded border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-200">
                Approved. The install script should finish on its own — return
                to that terminal.
              </div>
              <Link to="/" className="text-sm text-brand-500 hover:underline">
                Back to dashboard →
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="block text-xs uppercase tracking-wide text-neutral-500">
                Pair code
              </label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ABCD-1234"
                className="w-full rounded border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-sm uppercase text-neutral-100 placeholder:text-neutral-600 focus:border-brand-500/60 focus:outline-none"
                disabled={confirm.isPending}
                autoFocus={!search.code}
              />
              <Button
                onClick={() => void onApprove()}
                disabled={confirm.isPending || !code.trim()}
              >
                {confirm.isPending ? 'Approving…' : 'Approve'}
              </Button>
              <FormError>{err}</FormError>
              <p className="text-xs text-neutral-500">
                The code expires a few minutes after the install script runs.
                If the approve button errors with "expired", restart the
                install script to get a fresh one.
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
