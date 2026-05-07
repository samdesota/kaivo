import { createTRPCReact } from '@trpc/react-query'
import { createContext } from 'react'
import {
  createTRPCUntypedClient,
  createWSClient,
  httpBatchLink,
  splitLink,
  wsLink,
} from '@trpc/client'
import superjson from 'superjson'
import { envWsUrl, resolveEnvUrl, type EnvRef } from './lib/env-client'
import type { AppRouter as EnvAppRouter } from '../packages/env-server/src/trpc/router'

const envTrpcContext = createContext(null)

export const envTrpc = createTRPCReact<EnvAppRouter>({
  context: envTrpcContext,
})

function wsRetryDelayMs(attemptIndex: number): number {
  return Math.min(1_000 * 2 ** attemptIndex, 10_000)
}

export function makeEnvReactClient(env: EnvRef, envToken: string) {
  return makeManagedEnvReactClient(env, envToken).client
}

export function makeManagedEnvReactClient(env: EnvRef, envToken: string) {
  const base = resolveEnvUrl(env)
  const ws = createWSClient({
    url: envWsUrl(env, '/trpc'),
    connectionParams: { token: envToken },
    retryDelayMs: wsRetryDelayMs,
    keepAlive: {
      enabled: true,
      intervalMs: 10_000,
      pongTimeoutMs: 3_000,
    },
  })
  const client = createTRPCUntypedClient<EnvAppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: wsLink({ client: ws, transformer: superjson }),
        false: httpBatchLink({
          url: `${base}/trpc`,
          transformer: superjson,
          async headers() {
            return { authorization: `Bearer ${envToken}` }
          },
          fetch(url, options) {
            return fetch(url, { ...options, credentials: 'omit' })
          },
        }),
      }),
    ],
  })
  return { client, close: () => ws.close() }
}
