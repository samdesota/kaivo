import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { trpc, makeTrpcClient } from './trpc'
import { router } from './router'
import { initFontSize, initThemeColor } from './lib/ui-prefs'
import { installClientLogCapture } from './lib/client-logger'
import { installDesktopDiagnostics } from './lib/desktop-diagnostics'
import './index.css'

initFontSize()
initThemeColor()
installClientLogCapture()
installDesktopDiagnostics()

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
        <Suspense fallback={<AppSuspenseFallback />}>
          <RouterProvider router={router} />
        </Suspense>
      </QueryClientProvider>
    </trpc.Provider>
  </StrictMode>,
)

function AppSuspenseFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-975 text-help">
      <div className="window-drag fixed top-0 right-0 left-0 h-10" />
      Loading…
    </div>
  )
}
