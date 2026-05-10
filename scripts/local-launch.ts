import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import * as runtime from '../packages/zoottle-desktop/src/instance-runtime.ts'
import type { InstanceRuntimeConfig, RuntimePortName } from '../packages/zoottle-desktop/src/instance-runtime'
import * as desktopPairing from '../packages/zoottle-desktop/src/desktop-pairing.ts'
import { runDevSeed } from './seed-dev'

const runtimeModule = runtime as typeof runtime & { default?: typeof runtime }
const resolveRuntimeConfig = runtime.resolveInstanceRuntimeConfig ?? runtimeModule.default?.resolveInstanceRuntimeConfig
if (!resolveRuntimeConfig) throw new Error('Unable to load instance runtime resolver')
const desktopBrowserSocketPath = runtime.desktopBrowserSocketPath ?? runtimeModule.default?.desktopBrowserSocketPath
if (!desktopBrowserSocketPath) throw new Error('Unable to load desktop browser socket path helper')
const desktopPairingModule = desktopPairing as typeof desktopPairing & { default?: typeof desktopPairing }
const ensureDesktopPairing = desktopPairing.ensureDesktopPairing ?? desktopPairingModule.default?.ensureDesktopPairing
if (!ensureDesktopPairing) throw new Error('Unable to load desktop pairing helper')

type LaunchMode = 'browser' | 'desktop'
type LaunchServiceName = RuntimePortName
type LaunchServiceStatus = 'starting' | 'healthy' | 'failed'

export type LaunchManifestService = {
  name: LaunchServiceName
  role: string
  host: string
  port: number
  baseUrl: string
  healthUrl?: string
  pid?: number
  status: LaunchServiceStatus
  logPath: string
}

export type LaunchManifest = {
  instance: {
    id: string
    root: string
    worktree: string
    mode: LaunchMode
    generatedAt: string
  }
  servers: LaunchManifestService[]
  storage: {
    appDbPath: string
    envStateDir: string
    envDbPath: string
    envWorkspacePath: string
    appSecretsKeyPath: string
  }
  commands: {
    launch: string
    script: string
  }
}

export type LaunchedService = {
  name: LaunchServiceName
  pid?: number
  stop: () => Promise<void>
}

export type LocalLaunchResult = {
  config: InstanceRuntimeConfig
  manifest: LaunchManifest
  services: LaunchedService[]
  stop: () => Promise<void>
}

export type LocalLaunchOptions = {
  cwd?: string
  homeDir?: string
  env?: NodeJS.ProcessEnv
  mode?: LaunchMode
  maxAttempts?: number
  waitMs?: number
  pollMs?: number
  now?: () => Date
  command?: string
  script?: string
}

export type LocalLaunchDeps = {
  isPortAvailable?: (port: number, service: RuntimePortName) => Promise<boolean>
  startServices?: (config: InstanceRuntimeConfig, options: RequiredLocalLaunchOptions) => Promise<LaunchedService[]>
  waitForServices?: (
    config: InstanceRuntimeConfig,
    services: LaunchedService[],
    options: RequiredLocalLaunchOptions,
  ) => Promise<void>
  seedApp?: (config: InstanceRuntimeConfig, options: RequiredLocalLaunchOptions) => Promise<void>
  pairServices?: (config: InstanceRuntimeConfig, options: RequiredLocalLaunchOptions) => Promise<void>
  writeManifest?: (config: InstanceRuntimeConfig, manifest: LaunchManifest) => Promise<void>
}

type RequiredLocalLaunchOptions = Required<LocalLaunchOptions>

const defaultMaxAttempts = 20
const defaultWaitMs = 15_000
const defaultPollMs = 100

export async function runLocalDevLauncher(
  options: LocalLaunchOptions = {},
  deps: LocalLaunchDeps = {},
): Promise<LocalLaunchResult> {
  const resolvedOptions = resolveOptions(options)
  const blockedPorts = new Set<number>()
  let lastError: unknown

  for (let attempt = 1; attempt <= resolvedOptions.maxAttempts; attempt += 1) {
    const config = await resolveFreeRuntimeConfig(resolvedOptions, deps, blockedPorts)
    ensureRuntimeDirs(config)
    let services: LaunchedService[] = []

    try {
      await (deps.seedApp ?? seedApp)(config, resolvedOptions)
      services = await (deps.startServices ?? startServices)(config, resolvedOptions)
      await writeManifest(config, buildLaunchManifest(config, resolvedOptions, services, 'starting'), deps)
      await (deps.waitForServices ?? waitForServices)(config, services, resolvedOptions)
      await (deps.pairServices ?? pairServices)(config, resolvedOptions)

      const manifest = buildLaunchManifest(config, resolvedOptions, services, 'healthy')
      await writeManifest(config, manifest, deps)
      return {
        config,
        manifest,
        services,
        stop: () => stopServices(services),
      }
    } catch (err) {
      lastError = err
      await stopServices(services)
      rememberPorts(config, blockedPorts)
      await writeManifest(config, buildLaunchManifest(config, resolvedOptions, services, 'failed'), deps)
    }
  }

  throw new Error(`Local launch failed after ${resolvedOptions.maxAttempts} attempts: ${errorMessage(lastError)}`)
}

async function seedApp(config: InstanceRuntimeConfig, options: RequiredLocalLaunchOptions): Promise<void> {
  await runDevSeed({
    cwd: options.cwd,
    env: {
      ...options.env,
      NODE_ENV: 'development',
      CC_SEED_TARGET: 'desktop-dev',
      CC_INSTANCE_ID: config.instanceId,
      CC_INSTANCE_ROOT: config.rootDir,
      CC_DESKTOP_BROWSER_SOCKET: desktopBrowserSocketPath(config),
      CC_APP_DATA_DIR: config.app.dataDir,
      CC_APP_SQLITE_PATH: config.app.sqlitePath,
      DATA_DIR: config.app.dataDir,
      APP_SQLITE_PATH: config.app.sqlitePath,
      CC_SERVICE_CREDENTIAL: options.env.CC_SERVICE_CREDENTIAL ?? 'local-dev-seed-service-credential',
    },
  })
}

async function pairServices(config: InstanceRuntimeConfig): Promise<void> {
  await ensureDesktopPairing(config)
}

export async function resolveFreeRuntimeConfig(
  options: RequiredLocalLaunchOptions,
  deps: Pick<LocalLaunchDeps, 'isPortAvailable'> = {},
  blockedPorts = new Set<number>(),
): Promise<InstanceRuntimeConfig> {
  const occupied = new Set(blockedPorts)

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const config = resolveRuntimeConfig(options.env, {
      cwd: options.cwd,
      homeDir: options.homeDir,
      mode: 'development',
      portAvailability: (port) => (occupied.has(port) ? 'occupied' : 'available'),
    })
    const checks = await Promise.all(
      runtimePorts(config).map(async ({ service, port }) => ({
        service,
        port,
        available: await (deps.isPortAvailable ?? isPortAvailable)(port, service),
      })),
    )
    const unavailable = checks.filter((check) => !check.available)
    if (unavailable.length === 0) return config
    for (const check of unavailable) occupied.add(check.port)
  }

  throw new Error(`No free local service ports found after ${options.maxAttempts} attempts`)
}

export function buildLaunchManifest(
  config: InstanceRuntimeConfig,
  options: RequiredLocalLaunchOptions,
  services: LaunchedService[],
  status: LaunchServiceStatus,
): LaunchManifest {
  const pids = new Map(services.map((service) => [service.name, service.pid]))
  return {
    instance: {
      id: config.instanceId,
      root: config.rootDir,
      worktree: options.cwd,
      mode: options.mode,
      generatedAt: options.now().toISOString(),
    },
    servers: [
      {
        name: 'app',
        role: 'identity/app server',
        host: config.app.host,
        port: config.app.port,
        baseUrl: config.app.url,
        healthUrl: config.app.healthUrl,
        pid: pids.get('app'),
        status,
        logPath: config.app.logPath,
      },
      {
        name: 'env',
        role: 'cc-env server',
        host: config.env.host,
        port: config.env.port,
        baseUrl: config.env.url,
        healthUrl: config.env.healthUrl,
        pid: pids.get('env'),
        status,
        logPath: config.env.logPath,
      },
      {
        name: 'client',
        role: 'client dev server',
        host: config.client.host,
        port: config.client.port,
        baseUrl: config.client.url,
        pid: pids.get('client'),
        status,
        logPath: config.client.logPath,
      },
    ],
    storage: {
      appDbPath: config.app.sqlitePath,
      envStateDir: config.env.stateDir,
      envDbPath: path.join(config.env.stateDir, 'env.db'),
      envWorkspacePath: config.env.workingDir,
      appSecretsKeyPath: path.join(config.app.dataDir, 'secrets.key'),
    },
    commands: {
      launch: options.command,
      script: options.script,
    },
  }
}

async function startServices(config: InstanceRuntimeConfig, options: RequiredLocalLaunchOptions): Promise<LaunchedService[]> {
  return [
    startProcess('app', appLaunchSpec(config, options.cwd)),
    startProcess('env', envLaunchSpec(config, options.cwd)),
    startProcess('client', clientLaunchSpec(config, options.cwd)),
  ]
}

async function waitForServices(
  config: InstanceRuntimeConfig,
  services: LaunchedService[],
  options: RequiredLocalLaunchOptions,
): Promise<void> {
  await Promise.all([
    waitForHealth('app', config.app.healthUrl, config.instanceId, options),
    waitForHealth('env', config.env.healthUrl, config.instanceId, options),
    waitForUrl('client', config.client.url, options),
  ])
  for (const service of services) {
    if (service.pid === undefined) throw new Error(`${service.name} service did not start`)
  }
}

function appLaunchSpec(config: InstanceRuntimeConfig, cwd: string): ServiceLaunchSpec {
  return {
    command: nodeCommand(),
    args: ['node_modules/.bin/tsx', 'server/index.ts'],
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      APP_SQLITE_PATH: config.app.sqlitePath,
      CC_INSTANCE_ID: config.instanceId,
      CC_INSTANCE_ROOT: config.rootDir,
      CC_DESKTOP_BROWSER_SOCKET: desktopBrowserSocketPath(config),
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

function envLaunchSpec(config: InstanceRuntimeConfig, cwd: string): ServiceLaunchSpec {
  return {
    command: nodeCommand(),
    args: ['node_modules/.bin/tsx', 'packages/env-server/src/main.ts'],
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      CC_KIND: 'local',
      CC_INSTANCE_ID: config.instanceId,
      CC_INSTANCE_ROOT: config.rootDir,
      CC_DESKTOP_BROWSER_SOCKET: desktopBrowserSocketPath(config),
      CC_LABEL: config.env.label,
      CC_PORT: String(config.env.port),
      CC_HOST: config.env.host,
      CC_STATE_DIR: config.env.stateDir,
      CC_WORKING_DIR: config.env.workingDir,
      CC_IDENTITY_URL: config.app.url,
      CC_ALLOWED_ORIGINS: `${config.app.url},${config.client.url}`,
      CC_OPENCODE_PLUGIN_PATH: `file://${path.join(cwd, 'packages/opencode-plugin/dist/index.js')}`,
      OPENCODE_ENABLE_EXA: '1',
    },
    logPath: config.env.logPath,
  }
}

function clientLaunchSpec(config: InstanceRuntimeConfig, cwd: string): ServiceLaunchSpec {
  return {
    command: nodeCommand(),
    args: ['node_modules/.bin/vite', '--host', config.client.host, '--port', String(config.client.port), '--strictPort'],
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      CC_INSTANCE_ID: config.instanceId,
      CC_INSTANCE_ROOT: config.rootDir,
      CC_DESKTOP_BROWSER_SOCKET: desktopBrowserSocketPath(config),
      CC_APP_URL: config.app.url,
      CC_CLIENT_HOST: config.client.host,
      CC_CLIENT_PORT: String(config.client.port),
      VITE_PORT: String(config.client.port),
    },
    logPath: config.client.logPath,
  }
}

type ServiceLaunchSpec = {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  logPath: string
}

function startProcess(name: LaunchServiceName, spec: ServiceLaunchSpec): LaunchedService {
  fs.mkdirSync(path.dirname(spec.logPath), { recursive: true })
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env })
  const log = fs.createWriteStream(spec.logPath, { flags: 'a' })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  child.once('exit', () => log.end())
  return {
    name,
    pid: child.pid,
    stop: () => stopProcess(child),
  }
}

async function waitForHealth(
  service: 'app' | 'env',
  healthUrl: string,
  instanceId: string,
  options: RequiredLocalLaunchOptions,
): Promise<void> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < options.waitMs) {
    try {
      const response = await fetch(healthUrl)
      if (response.ok) {
        const body = (await response.json()) as { ok?: boolean; instanceId?: string }
        if (!body.ok) throw new Error(`${service} service is unhealthy`)
        if (body.instanceId !== instanceId) {
          throw new Error(`${service} service instance mismatch: expected ${instanceId}, got ${body.instanceId ?? 'missing'}`)
        }
        return
      }
    } catch (err) {
      lastError = err
    }
    await delay(options.pollMs)
  }
  throw lastError instanceof Error ? lastError : new Error(`${service} service did not become healthy`)
}

async function waitForUrl(service: LaunchServiceName, url: string, options: RequiredLocalLaunchOptions): Promise<void> {
  const started = Date.now()
  let lastError: unknown
  while (Date.now() - started < options.waitMs) {
    try {
      const response = await fetch(url)
      if (response.status < 500) return
    } catch (err) {
      lastError = err
    }
    await delay(options.pollMs)
  }
  throw lastError instanceof Error ? lastError : new Error(`${service} service did not start`)
}

async function isPortAvailable(port: number, _service: RuntimePortName): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve(true))
    })
  })
}

async function writeManifest(
  config: InstanceRuntimeConfig,
  manifest: LaunchManifest,
  deps: Pick<LocalLaunchDeps, 'writeManifest'>,
): Promise<void> {
  if (deps.writeManifest) {
    await deps.writeManifest(config, manifest)
    return
  }
  const manifestPath = path.join(config.rootDir, 'launch.json')
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  const tmpPath = `${manifestPath}.${process.pid}.tmp`
  await fs.promises.writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await fs.promises.rename(tmpPath, manifestPath)
}

function resolveOptions(options: LocalLaunchOptions): RequiredLocalLaunchOptions {
  const cwd = path.resolve(options.cwd ?? process.cwd())
  return {
    cwd,
    homeDir: path.resolve(options.homeDir ?? process.env.HOME ?? cwd),
    env: options.env ?? process.env,
    mode: options.mode ?? 'browser',
    maxAttempts: options.maxAttempts ?? defaultMaxAttempts,
    waitMs: options.waitMs ?? defaultWaitMs,
    pollMs: options.pollMs ?? defaultPollMs,
    now: options.now ?? (() => new Date()),
    command: options.command ?? process.argv.join(' '),
    script: options.script ?? 'local-launch',
  }
}

function runtimePorts(config: InstanceRuntimeConfig): Array<{ service: RuntimePortName; port: number }> {
  return [
    { service: 'app', port: config.app.port },
    { service: 'env', port: config.env.port },
    { service: 'client', port: config.client.port },
  ]
}

function rememberPorts(config: InstanceRuntimeConfig, blockedPorts: Set<number>): void {
  for (const { port } of runtimePorts(config)) blockedPorts.add(port)
}

function ensureRuntimeDirs(config: InstanceRuntimeConfig): void {
  fs.mkdirSync(config.rootDir, { recursive: true })
  fs.mkdirSync(config.logsDir, { recursive: true })
  fs.mkdirSync(config.app.dataDir, { recursive: true })
  fs.mkdirSync(config.env.stateDir, { recursive: true })
  fs.mkdirSync(config.env.workingDir, { recursive: true })
}

async function stopServices(services: LaunchedService[]): Promise<void> {
  await Promise.all(services.map((service) => service.stop()))
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve())
    setTimeout(resolve, 1000).unref()
  })
}

function nodeCommand(): string {
  return process.env.CC_NODE_BIN ?? process.execPath
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function main(): Promise<void> {
  const result = await runLocalDevLauncher({ command: process.argv.join(' '), script: 'dev:local' })
  console.log(`Local Zoottle dev runtime started:`)
  console.log(`  app:    ${result.config.app.url}`)
  console.log(`  env:    ${result.config.env.url}`)
  console.log(`  client: ${result.config.client.url}`)
  console.log(`  manifest: ${path.join(result.config.rootDir, 'launch.json')}`)

  await new Promise<void>((resolve) => {
    const stop = async () => {
      await result.stop()
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

const currentFile = fileURLToPath(import.meta.url)
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
