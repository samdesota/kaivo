import { useQueryClient } from '@tanstack/react-query'
import { trpc } from '../trpc'
import { Button } from '../components/ui'

export function DashboardPage() {
  const qc = useQueryClient()
  const logout = trpc.auth.logout.useMutation()

  async function onLogout() {
    await logout.mutateAsync()
    await qc.invalidateQueries()
  }

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 rounded bg-brand-500" />
          <h1 className="text-lg font-semibold">Cloud Coding Environment</h1>
        </div>
        <Button onClick={onLogout} disabled={logout.isPending}>
          {logout.isPending ? 'Signing out…' : 'Sign out'}
        </Button>
      </header>
      <main className="mx-auto max-w-3xl p-8">
        <h2 className="text-xl font-medium">Welcome.</h2>
        <p className="mt-2 text-neutral-400">
          Phase 1 is live — auth works. Phase 2 will add sandboxes, files, and shells here.
        </p>
      </main>
    </div>
  )
}
