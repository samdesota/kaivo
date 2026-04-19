import { useEffect, useState } from 'react'

export type AgentUi = 'native' | 'iframe'

const KEY = 'cloud-code.agent_ui'
const DEFAULT: AgentUi = 'native'

function read(): AgentUi {
  if (typeof window === 'undefined') return DEFAULT
  const raw = window.localStorage.getItem(KEY)
  return raw === 'native' || raw === 'iframe' ? raw : DEFAULT
}

/** localStorage-backed toggle. Phase 6 flips the default to `'native'`. */
export function useAgentUiPreference(): [AgentUi, (next: AgentUi) => void] {
  const [value, setValue] = useState<AgentUi>(read)

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === KEY) setValue(read())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const update = (next: AgentUi) => {
    window.localStorage.setItem(KEY, next)
    setValue(next)
  }
  return [value, update]
}
