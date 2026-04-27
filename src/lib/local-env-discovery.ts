import { useEffect, useState } from 'react'
import { getLocalEnvStatus } from './env-client'

const DEFAULT_LOCAL_ENV_URL = 'http://127.0.0.1:47821'
const MANUAL_LOCAL_DISCOVERY_FLAG = 'CC_MANUAL_LOCAL_DISCOVERY'

export function useLocalEnvIdentity(): {
  label: string | null
  loading: boolean
} {
  const [label, setLabel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!manualLocalDiscoveryEnabled()) {
        setLabel(null)
        setLoading(false)
        return
      }
      const status = await getLocalEnvStatus(DEFAULT_LOCAL_ENV_URL)
      if (cancelled) return
      setLabel(status?.paired ? status.label : null)
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return { label, loading }
}

export { DEFAULT_LOCAL_ENV_URL }

function manualLocalDiscoveryEnabled(): boolean {
  return typeof window !== 'undefined' && window.localStorage.getItem(MANUAL_LOCAL_DISCOVERY_FLAG) === 'true'
}
