import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { trpc, makeTrpcClient } from './trpc'
import { router } from './router'
import { initFontSize } from './lib/ui-prefs'
import './index.css'

initFontSize()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Don't retry auth errors; fail fast to trigger redirects.
        const shape = (error as unknown as { data?: { httpStatus?: number } })?.data
        if (shape?.httpStatus === 401 || shape?.httpStatus === 403) return false
        return failureCount < 2
      },
    },
  },
})
const trpcClient = makeTrpcClient()

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
)
