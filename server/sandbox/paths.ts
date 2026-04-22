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
 * source. Docker rejects relative paths as volumes, so we always return an
 * absolute path: HOST_DATA_DIR when configured (compose uses this to bridge
 * the container's /data view to the host fs), otherwise an absolute version
 * of DATA_DIR (used in local dev where the app itself runs on the host).
 */
export function toHostPath(containerPath: string): string {
  const hostRoot = env.HOST_DATA_DIR
  if (!hostRoot) return path.resolve(containerPath)
  const dataDir = env.DATA_DIR
  if (containerPath === dataDir) return hostRoot
  if (containerPath.startsWith(dataDir + path.sep)) {
    return path.join(hostRoot, containerPath.slice(dataDir.length + 1))
  }
  return path.resolve(containerPath)
}

export function workspaceHostDir(sandboxId: string): string {
  return toHostPath(workspaceDir(sandboxId))
}

export function opencodeHostDir(sandboxId: string): string {
  return toHostPath(opencodeDir(sandboxId))
}
