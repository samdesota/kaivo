import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { app } from 'electron'
import type { InstanceRuntimeConfig } from './instance-runtime'
import { ensureDesktopPairing, type DesktopPairingResult } from './desktop-pairing'

export type ServiceName = 'app' | 'env'

export type ServiceHealth = {
  ok: boolean
  instanceId?: string
  label?: string
}

export type ManagedService = {
  name: ServiceName
  url: string
  process?: ChildProcessWithoutNullStreams
  launched: boolean
}

export type ServiceSupervisor = {
  app: ManagedService
  env: ManagedService
  pairing: DesktopPairingResult
  stop: () => Promise<void>
}

export type ServiceLaunchSpec = {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  logPath: string
}

export type ServiceSupervisorOptions = {
  cwd?: string
  fetchHealth?: (url: string) => Promise<ServiceHealth | null>
  launch?: (service: ServiceName, spec: ServiceLaunchSpec) => ChildProcessWithoutNullStreams
  pair?: (config: InstanceRuntimeConfig) => Promise<DesktopPairingResult>
  waitMs?: number
  pollMs?: number
}

const defaultWaitMs = 15_000
const defaultPollMs = 100

export async function ensureDesktopServices(
  config: InstanceRuntimeConfig,
  options: ServiceSupervisorOptions = {},
): Promise<ServiceSupervisor> {
  const fetchHealth = options.fetchHealth ?? defaultFetchHealth
  const launch = options.launch ?? defaultLaunch
  const cwd = options.cwd ?? resolveServiceRoot()
  const started: ManagedService[] = []

  const appSvc = await ensureService('app', config, {
    cwd,
    fetchHealth,
    launch,
    waitMs: options.waitMs ?? defaultWaitMs,
    pollMs: options.pollMs ?? defaultPollMs,
  })
  started.push(appSvc)

  const env = await ensureService('env', config, {
    cwd,
    fetchHealth,
    launch,
    waitMs: options.waitMs ?? defaultWaitMs,
    pollMs: options.pollMs ?? defaultPollMs,
  })
  started.push(env)
  const pairing = await (options.pair ?? ensureDesktopPairing)(config)

  return {
    app: appSvc,
    env,
    pairing,
    stop: async () => {
      await Promise.all(started.map((service) => stopProcess(service.process)))
    },
  }
}

async function ensureService(
  service: ServiceName,
  config: InstanceRuntimeConfig,
  options: Required<Pick<ServiceSupervisorOptions, 'fetchHealth' | 'launch' | 'cwd' | 'waitMs' | 'pollMs'>>,
): Promise<ManagedService> {
  const url = service === 'app' ? config.app.url : config.env.url
  const existing = await options.fetchHealth(`${url}/healthz`)
  if (existing) {
    assertMatchingHealth(service, config, existing)
    return { name: service, url, launched: false }
  }

  const child = options.launch(service, serviceLaunchSpec(service, config, options.cwd))
  await waitForService(service, config, options.fetchHealth, options.waitMs, options.pollMs)
  return { name: service, url, process: child, launched: true }
}

function assertMatchingHealth(service: ServiceName, config: InstanceRuntimeConfig, health: ServiceHealth): void {
  if (!health.ok) throw new Error(`${service} service is unhealthy`)
  if (service === 'app' && health.instanceId !== config.instanceId) {
    throw new Error(`app service instance mismatch: expected ${config.instanceId}, got ${health.instanceId ?? 'missing'}`)
  }
  if (service === 'env' && health.instanceId !== config.instanceId) {
    throw new Error(`env service instance mismatch: expected ${config.instanceId}, got ${health.instanceId ?? 'missing'}`)
  }
}

async function waitForService(
  service: ServiceName,
  config: InstanceRuntimeConfig,
  fetchHealth: (url: string) => Promise<ServiceHealth | null>,
  waitMs: number,
  pollMs: number,
): Promise<void> {
  const url = service === 'app' ? config.app.url : config.env.url
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < waitMs) {
    try {
      const health = await fetchHealth(`${url}/healthz`)
      if (health) {
        assertMatchingHealth(service, config, health)
        return
      }
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw lastError instanceof Error ? lastError : new Error(`${service} service did not become healthy`)
}

function bundleDir(): string {
  return path.join(app.getAppPath(), 'bundle')
}

function isPackagedBundle(): boolean {
  return app.isPackaged && fs.existsSync(path.join(bundleDir(), 'app-server', 'index.js'))
}

function serviceLaunchSpec(service: ServiceName, config: InstanceRuntimeConfig, cwd: string): ServiceLaunchSpec {
  if (isPackagedBundle()) {
    return packagedLaunchSpec(service, config)
  }
  return devLaunchSpec(service, config, cwd)
}

function packagedLaunchSpec(service: ServiceName, config: InstanceRuntimeConfig): ServiceLaunchSpec {
  const bundle = bundleDir()
  const node = nodeCommand()
  const nodeBinDir = path.dirname(node)
  const envPath = [nodeBinDir, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':')

  if (service === 'app') {
    const serverDir = path.join(bundle, 'app-server')
    return {
      command: node,
      args: [path.join(serverDir, 'index.js')],
      cwd: serverDir,
      env: {
        ...process.env,
        PATH: envPath,
        NODE_ENV: 'production',
        APP_SQLITE_PATH: config.app.sqlitePath,
        CC_INSTANCE_ID: config.instanceId,
        CC_SERVE_CLIENT: 'true',
        DATA_DIR: config.app.dataDir,
        PORT: String(config.app.port),
        HOST: config.app.host,
        PUBLIC_URL: config.app.url,
        CC_SERVICE_CREDENTIAL: process.env.CC_SERVICE_CREDENTIAL ?? 'local-desktop-service-credential',
      },
      logPath: config.app.logPath,
    }
  }

  const envDir = path.join(bundle, 'env-server')
  const pluginPath = `file://${path.join(bundle, 'opencode-plugin', 'index.js')}`

  return {
    command: node,
    args: [path.join(envDir, 'main.js')],
    cwd: envDir,
    env: {
      ...process.env,
      PATH: envPath,
      NODE_ENV: 'production',
      CC_KIND: 'local',
      CC_INSTANCE_ID: config.instanceId,
      CC_LABEL: config.env.label,
      CC_PORT: String(config.env.port),
      CC_HOST: config.env.host,
      CC_STATE_DIR: config.env.stateDir,
      CC_WORKING_DIR: config.env.workingDir,
      CC_IDENTITY_URL: config.app.url,
      CC_ALLOWED_ORIGINS: config.app.url,
      CC_OPENCODE_PLUGIN_PATH: pluginPath,
      OPENCODE_ENABLE_EXA: '1',
    },
    logPath: config.env.logPath,
  }
}

function devLaunchSpec(service: ServiceName, config: InstanceRuntimeConfig, cwd: string): ServiceLaunchSpec {
  if (service === 'app') {
    return {
      command: nodeCommand(),
      args: ['node_modules/.bin/tsx', 'server/index.ts'],
      cwd,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        APP_SQLITE_PATH: config.app.sqlitePath,
        CC_INSTANCE_ID: config.instanceId,
        CC_SERVE_CLIENT: 'true',
        DATA_DIR: config.app.dataDir,
        PORT: String(config.app.port),
        HOST: config.app.host,
        PUBLIC_URL: config.app.url,
        CC_SERVICE_CREDENTIAL: process.env.CC_SERVICE_CREDENTIAL ?? 'local-desktop-service-credential',
      },
      logPath: config.app.logPath,
    }
  }

  const pluginPath = `file://${path.join(cwd, 'packages/opencode-plugin/dist/index.js')}`

  return {
    command: nodeCommand(),
    args: ['node_modules/.bin/tsx', 'packages/env-server/src/main.ts'],
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CC_KIND: 'local',
      CC_INSTANCE_ID: config.instanceId,
      CC_LABEL: config.env.label,
      CC_PORT: String(config.env.port),
      CC_HOST: config.env.host,
      CC_STATE_DIR: config.env.stateDir,
      CC_WORKING_DIR: config.env.workingDir,
      CC_IDENTITY_URL: config.app.url,
      CC_ALLOWED_ORIGINS: config.app.url,
      CC_OPENCODE_PLUGIN_PATH: pluginPath,
      OPENCODE_ENABLE_EXA: '1',
    },
    logPath: config.env.logPath,
  }
}

function nodeCommand(): string {
  if (process.env.CC_NODE_BIN) return process.env.CC_NODE_BIN
  const candidates = [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    `${process.env.HOME}/.nvm/versions/node`,
  ]
  for (const c of candidates) {
    if (c.includes('.nvm')) {
      try {
        const versions = fs.readdirSync(c)
        const latest = versions.sort().reverse()[0]
        if (latest) {
          const p = path.join(c, latest, 'bin/node')
          if (fs.existsSync(p)) return p
        }
      } catch { /* ignore */ }
    } else if (fs.existsSync(c)) {
      return c
    }
  }
  return 'node'
}

function resolveServiceRoot(): string {
  let current = path.resolve(process.cwd())
  for (;;) {
    if (
      fs.existsSync(path.join(current, 'server/index.ts')) &&
      fs.existsSync(path.join(current, 'packages/env-server/src/main.ts'))
    ) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(process.cwd())
    current = parent
  }
}

async function defaultFetchHealth(url: string): Promise<ServiceHealth | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    return (await response.json()) as ServiceHealth
  } catch {
    return null
  }
}

function defaultLaunch(_service: ServiceName, spec: ServiceLaunchSpec): ChildProcessWithoutNullStreams {
  fs.mkdirSync(configDir(spec.logPath), { recursive: true })
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env })
  const log = fs.createWriteStream(spec.logPath, { flags: 'a' })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  child.once('exit', () => log.end())
  return child
}

async function stopProcess(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    setTimeout(resolve, 1000).unref()
  })
}

function configDir(filePath: string): string {
  return filePath.slice(0, filePath.lastIndexOf('/')) || '.'
}
