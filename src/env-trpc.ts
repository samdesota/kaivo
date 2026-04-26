import { createTRPCReact } from '@trpc/react-query'
import { createContext } from 'react'
import {
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

export function makeEnvReactClient(env: EnvRef, envToken: string) {
  const base = resolveEnvUrl(env)
  const ws = createWSClient({
    url: envWsUrl(env, '/trpc'),
    connectionParams: { token: envToken },
  })
  return envTrpc.createClient({
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
}
