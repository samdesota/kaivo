import { getEnvToken } from '../../lib/env-tokens'
import { makeEnvClient, type EnvRef } from '../../lib/env-client'
import type { WorkspaceTab } from './tab-state'

export type WorkspaceEnvRow = EnvRef & {
  label: string
  envToken: string | null
  localIdentityLabel: string | null
  status: 'running' | 'archived' | 'crashed' | 'unreachable'
}

export type WorkspaceEnvTarget = {
  env: WorkspaceEnvRow
  token: string | null
  available: boolean
  unavailableReason: string | null
}

export function resolveWorkspaceEnvTarget(env: WorkspaceEnvRow): WorkspaceEnvTarget {
  const token = env.envToken ?? getEnvToken(env.id)
  const unavailableReason =
    env.status !== 'running'
      ? `env is ${env.status}`
      : !token
        ? 'env token unavailable'
        : null
  return {
    env,
    token,
    available: unavailableReason === null,
    unavailableReason,
  }
}

export function selectLocalEnvTarget(targets: WorkspaceEnvTarget[]): WorkspaceEnvTarget | null {
  return targets.find((target) => target.env.kind === 'local' && target.available) ?? null
}

export function createWorkspaceEnvClientResolver(targets: WorkspaceEnvTarget[]) {
  const byId = new Map(targets.map((target) => [target.env.id, target]))
  return (envId: string) => {
    const target = byId.get(envId)
    if (!target) throw new Error(`env ${envId} is not visible to this workspace`)
    if (!target.available || !target.token) {
      throw new Error(target.unavailableReason ?? `env ${envId} is unavailable`)
    }
    return makeEnvClient(target.env, target.token)
  }
}

export function envIdForWorkspaceTab(tab: WorkspaceTab): string | null {
  return tab.type === 'browser' ? null : tab.envId
}

export function unavailableReasonForWorkspaceTab(
  tab: WorkspaceTab,
  targets: WorkspaceEnvTarget[],
): string | null {
  const envId = envIdForWorkspaceTab(tab)
  if (!envId) return null
  const target = targets.find((candidate) => candidate.env.id === envId)
  if (!target) return `env ${envId} is unavailable`
  return target.available ? null : target.unavailableReason
}
