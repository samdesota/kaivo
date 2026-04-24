import { createContext, useContext, type ReactNode } from 'react'
import type { EnvRef } from '../../lib/env-client'

export interface EnvContextValue {
  env: EnvRef & { label: string }
  envToken: string
}

const Ctx = createContext<EnvContextValue | null>(null)

export function EnvContextProvider({
  value,
  children,
}: {
  value: EnvContextValue
  children: ReactNode
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useEnv(): EnvContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useEnv must be used inside EnvContextProvider')
  return v
}
