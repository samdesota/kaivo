import { createHash } from 'node:crypto'
import path from 'node:path'

export type DesktopRuntimeMode = 'development' | 'production'

export type RuntimePortName = 'app' | 'env'

export type RuntimePortStatus = 'available' | 'same-instance' | 'occupied'

export type RuntimePortAvailability = (port: number, service: RuntimePortName) => RuntimePortStatus

export type RuntimePortSelectionSource = 'override' | 'persisted' | 'preferred' | 'fallback'

export type PersistedRuntimePorts = Partial<Record<RuntimePortName, number>>

export type RuntimePortSelection = {
  port: number
  source: RuntimePortSelectionSource
  shouldPersist: boolean
}

export type InstanceRuntimeConfig = {
  instanceId: string
  mode: DesktopRuntimeMode
  rootDir: string
  logsDir: string
  app: {
    host: string
    port: number
    url: string
    dataDir: string
    sqlitePath: string
    logPath: string
    portSelection: RuntimePortSelection
  }
  env: {
    host: string
    port: number
    url: string
    stateDir: string
    workingDir: string
    label: string
    logPath: string
    portSelection: RuntimePortSelection
  }
}

export type ResolveInstanceRuntimeOptions = {
  cwd?: string
  homeDir?: string
  mode?: DesktopRuntimeMode
  appIdentity?: string
  persistedPorts?: PersistedRuntimePorts
  portAvailability?: RuntimePortAvailability
}

const defaultHost = '127.0.0.1'
const defaultAppIdentity = 'cloud-code-desktop'

export function resolveInstanceRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveInstanceRuntimeOptions = {},
): InstanceRuntimeConfig {
  const mode = options.mode ?? (env.NODE_ENV === 'production' ? 'production' : 'development')
  const cwd = path.resolve(options.cwd ?? process.cwd())
  const homeDir = path.resolve(options.homeDir ?? process.env.HOME ?? cwd)
  const appIdentity = sanitizeId(env.CC_DESKTOP_APP_ID ?? options.appIdentity ?? defaultAppIdentity)
  const instanceId = sanitizeId(env.CC_INSTANCE_ID ?? defaultInstanceId(mode, cwd, appIdentity))
  const host = env.CC_DESKTOP_HOST ?? defaultHost
  const rootDir = path.resolve(env.CC_INSTANCE_ROOT ?? defaultRootDir(mode, homeDir, cwd, appIdentity, instanceId))
  const logsDir = path.resolve(env.CC_INSTANCE_LOG_DIR ?? path.join(rootDir, 'logs'))
  const appDataDir = path.resolve(env.CC_APP_DATA_DIR ?? path.join(rootDir, 'app'))
  const envStateDir = path.resolve(env.CC_ENV_STATE_DIR ?? path.join(rootDir, 'env-state'))
  const envWorkingDir = path.resolve(env.CC_ENV_WORKING_DIR ?? defaultWorkingDir(mode, homeDir, rootDir))
  const persistedPorts = options.persistedPorts ?? {}
  const portAvailability = options.portAvailability ?? (() => 'available')

  const appPortSelection = selectPort({
    service: 'app',
    override: env.CC_APP_PORT,
    persisted: persistedPorts.app,
    preferred: preferredPort(instanceId, 'app'),
    portAvailability,
  })
  const envPortSelection = selectPort({
    service: 'env',
    override: env.CC_ENV_PORT,
    persisted: persistedPorts.env,
    preferred: preferredPort(instanceId, 'env'),
    portAvailability,
  })
  const envLabel = env.CC_ENV_LABEL ?? `Cloud Code ${instanceId}`

  return {
    instanceId,
    mode,
    rootDir,
    logsDir,
    app: {
      host,
      port: appPortSelection.port,
      url: env.CC_APP_URL ?? `http://${host}:${appPortSelection.port}`,
      dataDir: appDataDir,
      sqlitePath: path.resolve(env.CC_APP_SQLITE_PATH ?? path.join(appDataDir, 'app.db')),
      logPath: path.resolve(env.CC_APP_LOG_PATH ?? path.join(logsDir, 'app.log')),
      portSelection: appPortSelection,
    },
    env: {
      host,
      port: envPortSelection.port,
      url: env.CC_ENV_URL ?? `http://${host}:${envPortSelection.port}`,
      stateDir: envStateDir,
      workingDir: envWorkingDir,
      label: envLabel,
      logPath: path.resolve(env.CC_ENV_LOG_PATH ?? path.join(logsDir, 'cc-env.log')),
      portSelection: envPortSelection,
    },
  }
}

function defaultInstanceId(mode: DesktopRuntimeMode, cwd: string, appIdentity: string): string {
  if (mode === 'production') return appIdentity
  return `dev-${shortHash(cwd)}`
}

function defaultRootDir(
  mode: DesktopRuntimeMode,
  homeDir: string,
  cwd: string,
  appIdentity: string,
  instanceId: string,
): string {
  if (mode === 'production') {
    return path.join(homeDir, 'Library', 'Application Support', appIdentity, 'instances', instanceId)
  }
  return path.join(cwd, '.cloud-code', 'instances', instanceId)
}

function defaultWorkingDir(mode: DesktopRuntimeMode, homeDir: string, rootDir: string): string {
  if (mode === 'production') return path.join(homeDir, 'd')
  return path.join(rootDir, 'workspaces')
}

function preferredPort(instanceId: string, service: RuntimePortName): number {
  const offset = parseInt(shortHash(`${instanceId}:${service}`).slice(0, 4), 16) % 1000
  return (service === 'app' ? 3100 : 48000) + offset
}

function selectPort(input: {
  service: RuntimePortName
  override?: string
  persisted?: number
  preferred: number
  portAvailability: RuntimePortAvailability
}): RuntimePortSelection {
  const override = parsePort(input.override)
  if (override) return { port: override, source: 'override', shouldPersist: false }

  if (input.persisted && canUsePort(input.persisted, input.service, input.portAvailability)) {
    return { port: input.persisted, source: 'persisted', shouldPersist: false }
  }

  if (canUsePort(input.preferred, input.service, input.portAvailability)) {
    return { port: input.preferred, source: 'preferred', shouldPersist: input.persisted !== input.preferred }
  }

  for (let port = input.preferred + 1; port < input.preferred + 1000 && port <= 65535; port += 1) {
    if (canUsePort(port, input.service, input.portAvailability)) {
      return { port, source: 'fallback', shouldPersist: true }
    }
  }

  throw new Error(`No available ${input.service} port near ${input.preferred}`)
}

function canUsePort(port: number, service: RuntimePortName, portAvailability: RuntimePortAvailability): boolean {
  const status = portAvailability(port, service)
  return status === 'available' || status === 'same-instance'
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${value}`)
  return port
}

function sanitizeId(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || defaultAppIdentity
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}
