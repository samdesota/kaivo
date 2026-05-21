import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { startAppDataSync } from './startup-sync'

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
    ;(window as unknown as { __kaivoAppDataProviderMounted?: boolean }).__kaivoAppDataProviderMounted = true
    void startAppDataSync()
      .then(() => {
        if (!cancelled) setReady(true)
      })
      .catch((err) => {
        console.warn('[app-data] startup sync failed', err)
        if (!cancelled) {
          setError(err)
          setReady(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const value = useMemo(() => ({ ready, error }), [ready, error])
  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>
}

export function useAppData() {
  return useContext(AppDataContext)
}
