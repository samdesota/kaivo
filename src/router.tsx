import { useEffect } from 'react'
import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router'
import { trpc } from './trpc'
import { LoginPage } from './routes/login'
import { SetupPage } from './routes/setup'
import { DashboardPage } from './routes/dashboard'

function RootLayout() {
  const navigate = useNavigate()
  const { location } = useRouterState()
  const status = trpc.auth.status.useQuery(undefined, {
    staleTime: 0,
    refetchOnWindowFocus: true,
  })

  useEffect(() => {
    if (!status.data) return
    const { firstRun, authenticated } = status.data
    const p = location.pathname

    if (firstRun && p !== '/setup') {
      void navigate({ to: '/setup', replace: true })
      return
    }
    if (!firstRun && !authenticated && p !== '/login') {
      void navigate({ to: '/login', replace: true })
      return
    }
    if (!firstRun && authenticated && (p === '/login' || p === '/setup')) {
      void navigate({ to: '/', replace: true })
    }
  }, [status.data, location.pathname, navigate])

  if (status.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-950 text-neutral-500">
        Loading…
      </div>
    )
  }

  return <Outlet />
}

const rootRoute = createRootRoute({ component: RootLayout })
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
})
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
})
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: SetupPage,
})

const routeTree = rootRoute.addChildren([indexRoute, loginRoute, setupRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
