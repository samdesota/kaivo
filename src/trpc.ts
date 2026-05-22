import { createTRPCReact } from '@trpc/react-query'
import { createContext } from 'react'
import {
  createTRPCUntypedClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
} from '@trpc/client'
import superjson from 'superjson'
import type { AppRouter } from '../server/trpc/router'

const identityTrpcContext = createContext(null)

export const trpc = createTRPCReact<AppRouter>({
  context: identityTrpcContext,
})

export function makeTrpcClient() {
  return createTRPCUntypedClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({
          url: '/trpc',
          transformer: superjson,
          eventSourceOptions: () => ({ withCredentials: true }),
        }),
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
