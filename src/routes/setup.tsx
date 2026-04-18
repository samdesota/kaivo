import { useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { trpc } from '../trpc'
import { Button, Card, CenteredLayout, FormError, Input, Label } from '../components/ui'
import { extractTrpcMessage } from '../lib/utils'

export function SetupPage() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const bootstrap = trpc.auth.bootstrap.useMutation()

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    try {
      await bootstrap.mutateAsync({ password })
      await qc.invalidateQueries()
      await navigate({ to: '/' })
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  return (
    <CenteredLayout>
      <Card>
        <h1 className="mb-2 text-2xl font-semibold">Set admin password</h1>
        <p className="mb-6 text-sm text-neutral-400">
          This is the first launch of this environment. Pick an admin password to continue.
        </p>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <Label htmlFor="password">New password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              autoFocus
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </div>
          <div>
            <Label htmlFor="confirm">Confirm password</Label>
            <Input
              id="confirm"
              type="password"
              value={confirm}
              autoComplete="new-password"
              onChange={(e) => setConfirm(e.target.value)}
              minLength={8}
              required
            />
          </div>
          <FormError>{error}</FormError>
          <Button type="submit" disabled={bootstrap.isPending} className="w-full">
            {bootstrap.isPending ? 'Creating…' : 'Set password and continue'}
          </Button>
        </form>
      </Card>
    </CenteredLayout>
  )
}
