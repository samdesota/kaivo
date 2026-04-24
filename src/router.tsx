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
import { SandboxDetailPage } from './routes/sandbox'
import { EnvDetailPage } from './routes/env'
import { SettingsPage } from './routes/settings'

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data, location.pathname])

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
const sandboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/sandbox/$id',
  component: SandboxDetailPage,
})
const envRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/env/$id',
  component: EnvDetailPage,
})
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  setupRoute,
  sandboxRoute,
  envRoute,
  settingsRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
