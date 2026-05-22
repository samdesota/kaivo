import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import './modules'
import { resetAppDataSync, startAppDataSync } from './startup-sync'

type AppDataContextValue = {
  ready: boolean
  error: unknown
}

const AppDataContext = createContext<AppDataContextValue>({ ready: false, error: null })

export function AppDataProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    ;(window as unknown as { __kaivoAppDataProviderMounted?: boolean }).__kaivoAppDataProviderMounted = true
    function run() {
      void startAppDataSync()
        .then(() => {
          ;(window as unknown as { __kaivoAppDataReady?: boolean }).__kaivoAppDataReady = true
          if (!cancelled) {
            setError(null)
            setReady(true)
          }
        })
        .catch((err) => {
          console.warn('[app-data] startup sync failed', err)
          ;(window as unknown as { __kaivoAppDataError?: string }).__kaivoAppDataError = err instanceof Error ? err.message : String(err)
          resetAppDataSync()
          if (!cancelled) {
            setError(err)
            retryTimer = setTimeout(run, 500)
          }
        })
    }
    run()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [])

  const value = useMemo(() => ({ ready, error }), [ready, error])
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>
}

export function useAppData() {
  return useContext(AppDataContext)
}
