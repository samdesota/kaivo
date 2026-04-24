import path from 'node:path'
import { env } from '../env.js'
import { toHostPath } from '../sandbox/paths.js'

// Label applied to every orchestrator-owned container for reconciliation.
export const ENV_CONTAINER_LABEL = 'cloud-code.env'

export function envRootDir(envId: string): string {
  return path.join(env.DATA_DIR, 'envs', envId)
}

/** Per-env working directory — the `/workspace` bind source. */
export function envWorkspaceDir(envId: string): string {
  return path.join(envRootDir(envId), 'workspace')
}

export function envWorkspaceHostDir(envId: string): string {
  return toHostPath(envWorkspaceDir(envId))
}

/** Per-env state dir — where cc-env keeps its SQLite + secrets file. */
export function envStateDir(envId: string): string {
  return path.join(envRootDir(envId), 'state')
}

export function envStateHostDir(envId: string): string {
  return toHostPath(envStateDir(envId))
}

export function containerNameForEnv(envId: string): string {
  return `cc-env-${envId}`
}
