import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type DesktopRuntimeMode = 'development' | 'production'

export type RuntimePortName = 'app' | 'env' | 'client'

export type RuntimePortStatus = 'available' | 'same-instance' | 'occupied'

export type RuntimePortAvailability = (port: number, service: RuntimePortName) => RuntimePortStatus

export type RuntimePortSelectionSource = 'override' | 'persisted' | 'preferred' | 'fallback'

export type PersistedRuntimePorts = Partial<Record<RuntimePortName, number>>

export type RuntimePortSelection = {
  port: number
  source: RuntimePortSelectionSource
  shouldPersist: boolean
}

export type RuntimePortSelections = Record<RuntimePortName, RuntimePortSelection>

export type InstanceRuntimeConfig = {
  instanceId: string
  mode: DesktopRuntimeMode
  rootDir: string
  logsDir: string
  app: {
    host: string
    port: number
    url: string
    healthUrl: string
    dataDir: string
    sqlitePath: string
    logPath: string
    portSelection: RuntimePortSelection
  }
  env: {
    host: string
    port: number
    url: string
    healthUrl: string
    stateDir: string
    workingDir: string
    label: string
    logPath: string
    portSelection: RuntimePortSelection
  }
  terminal: {
    socketPath: string
    logPath: string
  }
  client: {
    host: string
    port: number
    url: string
    logPath: string
    portSelection: RuntimePortSelection
  }
}

export function desktopBrowserSocketPath(config: Pick<InstanceRuntimeConfig, 'instanceId' | 'rootDir'>): string {
  return path.join('/tmp', `kaivo-browser-${sanitizeId(config.instanceId)}-${shortHash(config.rootDir)}.sock`)
}

export function desktopAuthTokenPath(config: Pick<InstanceRuntimeConfig, 'rootDir'>): string {
  return path.join(config.rootDir, 'desktop-auth-token')
}

export function readOrCreateDesktopAuthToken(config: Pick<InstanceRuntimeConfig, 'rootDir'>): string {
  const tokenPath = desktopAuthTokenPath(config)
  try {
    const existing = fs.readFileSync(tokenPath, 'utf8').trim()
    if (existing) return existing
  } catch {
    // Create below.
  }
  const token = randomBytes(32).toString('base64url')
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 })
  return token
}

export function desktopAuthExchangeUrl(appUrl: string, token: string, nextUrl = appUrl): string {
  const url = new URL('/internal/desktop-auth', appUrl)
  url.searchParams.set('token', token)
  url.searchParams.set('next', nextUrl)
  return url.toString()
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
const defaultAppIdentity = 'zoottle-desktop'

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

  const portSelections = selectRuntimePorts({
    overrides: {
      app: env.CC_APP_PORT,
      env: env.CC_ENV_PORT,
      client: env.CC_CLIENT_PORT ?? env.VITE_PORT,
    },
    persisted: persistedPorts,
    preferred: {
      app: preferredPort(instanceId, 'app'),
      env: preferredPort(instanceId, 'env'),
      client: preferredPort(instanceId, 'client'),
    },
    portAvailability,
  })
  const envLabel = env.CC_ENV_LABEL ?? `Kaivo ${instanceId}`
  const appUrl = env.CC_APP_URL ?? `http://${host}:${portSelections.app.port}`
  const envUrl = env.CC_ENV_URL ?? `http://${host}:${portSelections.env.port}`
  const clientUrl = env.CC_CLIENT_URL ?? env.CC_DESKTOP_DEV_URL ?? `http://${host}:${portSelections.client.port}`

  return {
    instanceId,
    mode,
    rootDir,
    logsDir,
    app: {
      host,
      port: portSelections.app.port,
      url: appUrl,
      healthUrl: `${appUrl}/healthz`,
      dataDir: appDataDir,
      sqlitePath: path.resolve(env.CC_APP_SQLITE_PATH ?? path.join(appDataDir, 'app.db')),
      logPath: path.resolve(env.CC_APP_LOG_PATH ?? path.join(logsDir, 'app.log')),
      portSelection: portSelections.app,
    },
    env: {
      host,
      port: portSelections.env.port,
      url: envUrl,
      healthUrl: `${envUrl}/healthz`,
      stateDir: envStateDir,
      workingDir: envWorkingDir,
      label: envLabel,
      logPath: path.resolve(env.CC_ENV_LOG_PATH ?? path.join(logsDir, 'cc-env.log')),
      portSelection: portSelections.env,
    },
    terminal: {
      socketPath: path.resolve(env.CC_TERMINAL_SOCKET ?? path.join(rootDir, 'terminal.sock')),
      logPath: path.resolve(env.CC_TERMINAL_LOG_PATH ?? path.join(logsDir, 'terminal.log')),
    },
    client: {
      host,
      port: portSelections.client.port,
      url: clientUrl,
      logPath: path.resolve(env.CC_CLIENT_LOG_PATH ?? path.join(logsDir, 'client.log')),
      portSelection: portSelections.client,
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
  return path.join(cwd, '.kaivo', 'instances', instanceId)
}

function defaultWorkingDir(mode: DesktopRuntimeMode, homeDir: string, rootDir: string): string {
  if (mode === 'production') return path.join(homeDir, 'd')
  return path.join(rootDir, 'workspaces')
}

function preferredPort(instanceId: string, service: RuntimePortName): number {
  const offset = parseInt(shortHash(`${instanceId}:${service}`).slice(0, 4), 16) % 1000
  if (service === 'app') return 3100 + offset
  if (service === 'env') return 48000 + offset
  return 5100 + offset
}

export function selectRuntimePorts(input: {
  overrides?: Partial<Record<RuntimePortName, string | undefined>>
  persisted?: PersistedRuntimePorts
  preferred: Record<RuntimePortName, number>
  portAvailability: RuntimePortAvailability
}): RuntimePortSelections {
  const usedPorts = new Map<number, RuntimePortName>()
  const selections = {} as RuntimePortSelections

  for (const service of ['app', 'env', 'client'] as const) {
    const selection = selectPort({
      service,
      override: input.overrides?.[service],
      persisted: input.persisted?.[service],
      preferred: input.preferred[service],
      portAvailability: input.portAvailability,
      isPortReserved: (port) => usedPorts.has(port),
    })
    const reservedBy = usedPorts.get(selection.port)
    if (reservedBy) throw new Error(`Port ${selection.port} selected for both ${reservedBy} and ${service}`)
    usedPorts.set(selection.port, service)
    selections[service] = selection
  }

  return selections
}

function selectPort(input: {
  service: RuntimePortName
  override?: string
  persisted?: number
  preferred: number
  portAvailability: RuntimePortAvailability
  isPortReserved?: (port: number) => boolean
}): RuntimePortSelection {
  const override = parsePort(input.override)
  if (override) {
    if (input.isPortReserved?.(override)) throw new Error(`Port ${override} is already selected by another service`)
    return { port: override, source: 'override', shouldPersist: false }
  }

  if (input.persisted && canUsePort(input.persisted, input.service, input.portAvailability, input.isPortReserved)) {
    return { port: input.persisted, source: 'persisted', shouldPersist: false }
  }

  if (canUsePort(input.preferred, input.service, input.portAvailability, input.isPortReserved)) {
    return { port: input.preferred, source: 'preferred', shouldPersist: input.persisted !== input.preferred }
  }

  for (let port = input.preferred + 1; port < input.preferred + 1000 && port <= 65535; port += 1) {
    if (canUsePort(port, input.service, input.portAvailability, input.isPortReserved)) {
      return { port, source: 'fallback', shouldPersist: true }
    }
  }

  throw new Error(`No available ${input.service} port near ${input.preferred}`)
}

function canUsePort(
  port: number,
  service: RuntimePortName,
  portAvailability: RuntimePortAvailability,
  isPortReserved: ((port: number) => boolean) | undefined,
): boolean {
  if (isPortReserved?.(port)) return false
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
