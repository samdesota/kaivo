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
