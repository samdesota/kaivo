import { createTRPCReact } from '@trpc/react-query'
import { httpBatchLink } from '@trpc/client'
import superjson from 'superjson'
import type { AppRouter } from '../server/trpc/router'

export const trpc = createTRPCReact<AppRouter>()

export function makeTrpcClient() {
  return trpc.createClient({
    links: [
      httpBatchLink({
        url: '/trpc',
        transformer: superjson,
        fetch(url, options) {
          return fetch(url, { ...options, credentials: 'include' })
        },
      }),
    ],
  })
}
