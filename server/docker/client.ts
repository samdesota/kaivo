import Docker from 'dockerode'
import { logger } from '../logger.js'

let docker: Docker | null = null

export function getDocker(): Docker {
  if (docker) return docker
  const socketPath = process.env.DOCKER_HOST ? undefined : '/var/run/docker.sock'
  docker = new Docker(socketPath ? { socketPath } : undefined)
  return docker
}

export async function ensureNetwork(name: string): Promise<void> {
  const d = getDocker()
  try {
    const net = d.getNetwork(name)
    await net.inspect()
  } catch (err) {
    const code = (err as { statusCode?: number }).statusCode
    if (code !== 404) {
      logger.warn({ err }, 'ensureNetwork inspect failed')
    }
    try {
      await d.createNetwork({ Name: name, Driver: 'bridge', CheckDuplicate: true })
      logger.info({ network: name }, 'created docker network')
    } catch (createErr) {
      const createCode = (createErr as { statusCode?: number }).statusCode
      // 409 means someone raced us; treat as success.
      if (createCode !== 409) throw createErr
    }
  }
}

export async function dockerPing(): Promise<boolean> {
  try {
    await getDocker().ping()
    return true
  } catch {
    return false
  }
}
