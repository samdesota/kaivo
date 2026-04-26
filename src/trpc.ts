import { createTRPCReact } from '@trpc/react-query'
import { createContext } from 'react'
import {
  createWSClient,
  httpBatchLink,
  splitLink,
  wsLink,
} from '@trpc/client'
import superjson from 'superjson'
import type { AppRouter } from '../server/trpc/router'

const identityTrpcContext = createContext(null)

export const trpc = createTRPCReact<AppRouter>({
  context: identityTrpcContext,
})

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}/trpc`
}

export function makeTrpcClient() {
  const ws = createWSClient({ url: wsUrl() })
  return trpc.createClient({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: wsLink({ client: ws, transformer: superjson }),
        false: httpBatchLink({
          url: '/trpc',
          transformer: superjson,
          fetch(url, options) {
            return fetch(url, { ...options, credentials: 'include' })
          },
        }),
      }),
    ],
  })
}
