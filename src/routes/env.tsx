import { useMemo } from 'react'
import { useParams, Link } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { trpc } from '../trpc'
import { extractTrpcMessage } from '../lib/utils'
import { getEnvToken } from '../lib/env-tokens'
import { envTrpc, makeEnvReactClient } from '../env-trpc'
import { EnvTabShell, EnvContextProvider } from './env/tab-shell'

type EnvRow = {
  id: string
  kind: 'container' | 'local'
  label: string
  url: string
  status: 'running' | 'archived' | 'crashed' | 'unreachable'
}

export function EnvDetailPage() {
  const { id } = useParams({ from: '/env/$id' })
  const list = trpc.env.list.useQuery(undefined, { refetchInterval: 10_000 })

  if (list.isLoading) {
    return <div className="p-8 text-neutral-500">Loading env…</div>
  }
  if (list.error) {
    return <ErrorShell message={extractTrpcMessage(list.error)} />
  }
  const env = list.data?.find((e) => e.id === id) as EnvRow | undefined
  if (!env) {
    return (
      <ErrorShell message={`No env with id ${id}. It may have been deleted.`} />
    )
  }
  const token = getEnvToken(id)
  if (!token) {
    return <NoTokenShell label={env.label} />
  }
  if (env.status === 'archived') {
    return <ArchivedShell label={env.label} />
  }

  return <EnvInner env={env} envToken={token} />
}

function EnvInner({ env, envToken }: { env: EnvRow; envToken: string }) {
  // Fresh React-Query + tRPC clients per env, so cached data doesn't leak
  // between envs and a token rotation forces a clean remount.
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: (failureCount, error) => {
              const shape = (
                error as unknown as { data?: { httpStatus?: number } }
              )?.data
              if (shape?.httpStatus === 401 || shape?.httpStatus === 403)
                return false
              return failureCount < 2
            },
          },
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [env.id, envToken],
  )
  const trpcClient = useMemo(
    () => makeEnvReactClient({ id: env.id, kind: env.kind, url: env.url }, envToken),
    [env.id, env.kind, env.url, envToken],
  )

  return (
    <envTrpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <EnvContextProvider
          value={{
            env: { id: env.id, kind: env.kind, url: env.url, label: env.label },
            envToken,
          }}
        >
          <EnvTabShell env={env} />
        </EnvContextProvider>
      </QueryClientProvider>
    </envTrpc.Provider>
  )
}

function ErrorShell({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-neutral-950 p-8 text-neutral-100">
      <div className="text-red-400">{message}</div>
      <div className="mt-4">
        <Link to="/" className="text-brand-500 hover:underline">
          Back to dashboard
        </Link>
      </div>
    </div>
  )
}

function NoTokenShell({ label }: { label: string }) {
  return (
    <div className="min-h-screen bg-neutral-950 p-8 text-neutral-100">
      <h1 className="text-lg font-semibold">{label}</h1>
      <p className="mt-4 max-w-xl text-neutral-300">
        This browser doesn't have a token for this env. Tokens live in{' '}
        <code>localStorage</code> and are issued once at pairing time — a
        different browser or a cleared storage would need to re-pair.
      </p>
      <p className="mt-2 text-sm text-neutral-500">
        Container envs: delete and recreate the env. Local envs: unregister
        then run <code>cc-env pair reset</code> and re-add.
      </p>
      <div className="mt-6">
        <Link to="/" className="text-brand-500 hover:underline">
          Back to dashboard
        </Link>
      </div>
    </div>
  )
}

function ArchivedShell({ label }: { label: string }) {
  return (
    <div className="min-h-screen bg-neutral-950 p-8 text-neutral-100">
      <h1 className="text-lg font-semibold">{label}</h1>
      <p className="mt-4 text-neutral-400">
        This env is archived. Unarchive it from the dashboard to resume work.
      </p>
      <div className="mt-6">
        <Link to="/" className="text-brand-500 hover:underline">
          Back to dashboard
        </Link>
      </div>
    </div>
  )
}
