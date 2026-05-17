import path from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as runtime from '../packages/zoottle-desktop/src/instance-runtime.ts'
import { runLocalDevLauncher } from './local-launch'

const runtimeModule = runtime as typeof runtime & { default?: typeof runtime }
const desktopBrowserSocketPath = runtime.desktopBrowserSocketPath ?? runtimeModule.default?.desktopBrowserSocketPath
if (!desktopBrowserSocketPath) throw new Error('Unable to load desktop browser socket path helper')
const readOrCreateDesktopAuthToken = runtime.readOrCreateDesktopAuthToken ?? runtimeModule.default?.readOrCreateDesktopAuthToken
if (!readOrCreateDesktopAuthToken) throw new Error('Unable to load desktop auth token helper')

async function main(): Promise<void> {
  const cwd = path.resolve(process.cwd())
  const result = await runLocalDevLauncher({
    cwd,
    command: process.argv.join(' '),
    script: 'dev:desktop',
    mode: 'desktop',
  })

  console.log(`Local Kaivo desktop runtime started:`)
  console.log(`  app:      ${result.config.app.url}`)
  console.log(`  env:      ${result.config.env.url}`)
  console.log(`  client:   ${result.config.client.url}`)
  console.log(`  manifest: ${path.join(result.config.rootDir, 'launch.json')}`)
  console.log(`  desktop auth: enabled`)

  const desktopCwd = path.join(cwd, 'packages/zoottle-desktop')
  run('npm', ['run', 'build'], desktopCwd)

  const electron = spawn('node_modules/.bin/electron', ['dist/main.js'], {
    cwd: desktopCwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      CC_DESKTOP_MANAGE_SERVICES: 'false',
      CC_DESKTOP_CHROME_URL: result.config.app.url,
      CC_INSTANCE_ID: result.config.instanceId,
      CC_INSTANCE_ROOT: result.config.rootDir,
      CC_DESKTOP_BROWSER_SOCKET: desktopBrowserSocketPath(result.config),
      CC_DESKTOP_AUTH_TOKEN: readOrCreateDesktopAuthToken(result.config),
      CC_APP_PORT: String(result.config.app.port),
      CC_APP_URL: result.config.app.url,
      CC_APP_DATA_DIR: result.config.app.dataDir,
      CC_APP_SQLITE_PATH: result.config.app.sqlitePath,
      CC_APP_LOG_PATH: result.config.app.logPath,
      CC_ENV_PORT: String(result.config.env.port),
      CC_ENV_URL: result.config.env.url,
      CC_ENV_STATE_DIR: result.config.env.stateDir,
      CC_ENV_WORKING_DIR: result.config.env.workingDir,
      CC_ENV_LABEL: result.config.env.label,
      CC_ENV_LOG_PATH: result.config.env.logPath,
      CC_CLIENT_PORT: String(result.config.client.port),
      CC_CLIENT_URL: result.config.client.url,
      CC_CLIENT_LOG_PATH: result.config.client.logPath,
    },
  })

  await waitForExit(electron)
  await result.stop()
}

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`)
}

async function waitForExit(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code && code !== 0) reject(new Error(`electron exited with ${code}`))
      else if (signal) reject(new Error(`electron exited from ${signal}`))
      else resolve()
    })
  })
}

void main().catch(async (err) => {
  console.error(err)
  process.exit(1)
})
