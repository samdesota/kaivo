import { useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { trpc } from '../trpc'
import { Button, Card, CenteredLayout, FormError, Input, Label } from '../components/ui'
import { extractTrpcMessage } from '../lib/utils'

export function LoginPage() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const qc = useQueryClient()
  const login = trpc.auth.login.useMutation()

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await login.mutateAsync({ password })
      await qc.invalidateQueries()
      await navigate({ to: '/' })
    } catch (err) {
      setError(extractTrpcMessage(err))
    }
  }

  return (
    <CenteredLayout>
      <Card>
        <h1 className="mb-2 text-2xl font-semibold">Cloud Coding Environment</h1>
        <p className="mb-6 text-sm text-neutral-400">Sign in with your admin password.</p>
        <form onSubmit={onSubmit} className="space-y-4">
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              autoFocus
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <FormError>{error}</FormError>
          <Button type="submit" disabled={login.isPending} className="w-full">
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </Card>
    </CenteredLayout>
  )
}
