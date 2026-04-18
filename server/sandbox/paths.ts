import path from 'node:path'
import { env } from '../env.js'

export const SANDBOX_LABEL = 'coding-env.sandbox'

export function sandboxRootDir(sandboxId: string): string {
  return path.join(env.DATA_DIR, 'sandboxes', sandboxId)
}

export function workspaceDir(sandboxId: string): string {
  return path.join(sandboxRootDir(sandboxId), 'workspace')
}

export function opencodeDir(sandboxId: string): string {
  return path.join(sandboxRootDir(sandboxId), 'opencode')
}

/**
 * Translate a container-local path under DATA_DIR into the equivalent
 * host-side path, so it can be passed to the Docker daemon as a bind-mount
 * source. Returns the original path when HOST_DATA_DIR isn't configured.
 */
export function toHostPath(containerPath: string): string {
  const hostRoot = env.HOST_DATA_DIR
  if (!hostRoot) return containerPath
  const dataDir = env.DATA_DIR
  if (containerPath === dataDir) return hostRoot
  if (containerPath.startsWith(dataDir + path.sep)) {
    return path.join(hostRoot, containerPath.slice(dataDir.length + 1))
  }
  return containerPath
}

export function workspaceHostDir(sandboxId: string): string {
  return toHostPath(workspaceDir(sandboxId))
}

export function opencodeHostDir(sandboxId: string): string {
  return toHostPath(opencodeDir(sandboxId))
}
