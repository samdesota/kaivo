import { useEffect, useState } from 'react'
import { getLocalEnvStatus } from './env-client'

const DEFAULT_LOCAL_ENV_URL = 'http://127.0.0.1:47821'

export function useLocalEnvIdentity(): {
  label: string | null
  loading: boolean
} {
  const [label, setLabel] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
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
