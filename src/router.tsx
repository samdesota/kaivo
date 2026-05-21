import { Suspense, startTransition, useEffect } from 'react'
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
import { WorkspaceLandingPage } from './routes/workspace-landing'
import { GlobalTabsPage, WorkspacePage } from './routes/workspace'
import { EnvAuthDevicePage } from './routes/envauth-device'
import { SettingsPage } from './routes/settings'
import { OverlayLayerPage } from './routes/internal/overlay-layer'

function RootLayout() {
  const navigate = useNavigate()
  const { location } = useRouterState()
  const [status] = trpc.auth.status.useSuspenseQuery(undefined, {
    staleTime: 0,
    refetchOnWindowFocus: true,
  })

  useEffect(() => {
    const { firstRun, authenticated } = status
    const p = location.pathname

    if (firstRun && p !== '/setup') {
      startTransition(() => void navigate({ to: '/setup', replace: true }))
      return
    }
    if (!firstRun && !authenticated && p !== '/login') {
      // Preserve deep links like /envauth/device?code=… so the user lands
      // back on the page they meant to hit after signing in.
      const path = `${location.pathname}${location.searchStr ?? ''}`
      const next = path && path !== '/' ? path : undefined
      startTransition(() => void navigate({ to: '/login', search: { next }, replace: true }))
      return
    }
    if (!firstRun && authenticated && (p === '/login' || p === '/setup')) {
      const s = location.search as { next?: string } | undefined
      const next =
        typeof s?.next === 'string' && s.next.startsWith('/') ? s.next : null
      startTransition(() => void navigate({ to: next ?? '/', replace: true }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, location.pathname])

  return (
    <Suspense fallback={<RouteSuspenseFallback />}>
      <Outlet />
    </Suspense>
  )
}

function RouteSuspenseFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-975 text-help">
      <div className="window-drag fixed top-0 right-0 left-0 h-10" />
      Loading…
    </div>
  )
}

const rootRoute = createRootRoute({ component: RootLayout })
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: WorkspaceLandingPage,
})
const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/dashboard',
  component: DashboardPage,
})
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
  validateSearch: (s: Record<string, unknown>) => ({
    next: typeof s.next === 'string' ? s.next : undefined,
  }),
})
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: SetupPage,
})
const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/w/$workspaceId',
  component: WorkspacePage,
  validateSearch: (s: Record<string, unknown>) => ({
    chat: typeof s.chat === 'string' ? s.chat : undefined,
    tab: typeof s.tab === 'string' ? s.tab : undefined,
  }),
})
const globalTabsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tabs',
  component: GlobalTabsPage,
  validateSearch: (s: Record<string, unknown>) => ({
    tab: typeof s.tab === 'string' ? s.tab : undefined,
  }),
})
const envAuthDeviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/envauth/device',
  component: EnvAuthDevicePage,
  validateSearch: (s: Record<string, unknown>) => ({
    code: typeof s.code === 'string' ? s.code : undefined,
  }),
})
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
})
const overlayLayerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/internal/overlay-layer',
  component: OverlayLayerPage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  dashboardRoute,
  loginRoute,
  setupRoute,
  workspaceRoute,
  globalTabsRoute,
  envAuthDeviceRoute,
  settingsRoute,
  overlayLayerRoute,
])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
