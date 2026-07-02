import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  ONEPASSWORD_EXTENSION_ID,
  type OnePasswordDesktopConfig,
  type OnePasswordInstallResult,
  type OnePasswordManualConfigInput,
  type OnePasswordStatus,
} from '../../../shared/desktop-onepassword'
import type { InstanceRuntimeConfig } from './instance-runtime'

export type OnePasswordRuntime = {
  getStatus: () => OnePasswordStatus
  resetConfig: () => OnePasswordStatus
  saveManualConfig: (input: OnePasswordManualConfigInput) => OnePasswordStatus
  install: () => Promise<OnePasswordInstallResult>
  getWebFrameOptions: () => OnePasswordWebFrameOptions
  setRuntimeLoadError: (error: string | undefined) => void
}

export type OnePasswordWebFrameOptions = {
  extensions?: Array<{ path: string; allowFileAccess: boolean }>
  chromeExtensions?: { enabled: boolean; license: 'GPL-3.0' }
  nativeMessaging?: {
    hosts: Array<{ manifestPath: string; hostName: string; allowedExtensionIds: string[] }>
  }
}

export type OnePasswordRuntimeOptions = {
  instance: Pick<InstanceRuntimeConfig, 'rootDir'>
  env?: NodeJS.ProcessEnv
  homeDir?: string
  runtimeLoadError?: string
}

type ResolvedOnePasswordConfig = {
  enabled: boolean
  extensionId: string
  extensionPath?: string
  extensionSource?: 'downloaded' | 'manual' | 'env'
  nativeHostManifestPath?: string
}

export function createOnePasswordRuntime(options: OnePasswordRuntimeOptions): OnePasswordRuntime {
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? env.HOME ?? process.env.HOME
  const rootDir = options.instance.rootDir
  const configPath = onePasswordConfigPath(options.instance)
  let runtimeLoadError = options.runtimeLoadError

  function getStatus(): OnePasswordStatus {
    const resolved = resolveOnePasswordConfig(configPath, env)
    const extension = validateExtensionPath(resolved.extensionPath)
    const nativeHost = validateNativeHostManifest(resolveNativeHostManifestPath(resolved.nativeHostManifestPath, homeDir), resolved.extensionId)
    const enabledWithPath = resolved.enabled && Boolean(resolved.extensionPath)

    if (runtimeLoadError) {
      return {
        available: true,
        state: 'error',
        enabled: resolved.enabled,
        extensionId: resolved.extensionId,
        extensionPath: resolved.extensionPath,
        extensionVersion: extension.version,
        extensionSource: resolved.extensionSource,
        nativeHostManifestPath: nativeHost.manifestPath,
        nativeHostState: nativeHost.state,
        nativeHostMessage: nativeHost.message,
        requiresRestart: false,
        error: runtimeLoadError,
      }
    }

    if (!enabledWithPath) {
      return {
        available: true,
        state: 'not-installed',
        enabled: resolved.enabled,
        extensionId: resolved.extensionId,
        extensionPath: resolved.extensionPath,
        extensionVersion: extension.version,
        extensionSource: resolved.extensionSource,
        nativeHostManifestPath: nativeHost.manifestPath,
        nativeHostState: nativeHost.state,
        nativeHostMessage: nativeHost.message,
        requiresRestart: false,
        error: extension.error,
      }
    }

    if (!extension.valid) {
      return {
        available: true,
        state: 'error',
        enabled: resolved.enabled,
        extensionId: resolved.extensionId,
        extensionPath: resolved.extensionPath,
        extensionSource: resolved.extensionSource,
        nativeHostManifestPath: nativeHost.manifestPath,
        nativeHostState: nativeHost.state,
        nativeHostMessage: nativeHost.message,
        requiresRestart: false,
        error: extension.error,
      }
    }

    return {
      available: true,
      state: nativeHost.state === 'valid' ? 'ready' : 'extension-installed',
      enabled: true,
      extensionId: resolved.extensionId,
      extensionPath: resolved.extensionPath,
      extensionVersion: extension.version,
      extensionSource: resolved.extensionSource,
      nativeHostManifestPath: nativeHost.manifestPath,
      nativeHostState: nativeHost.state,
      nativeHostMessage: nativeHost.message,
      requiresRestart: false,
    }
  }

  function resetConfig(): OnePasswordStatus {
    fs.rmSync(configPath, { force: true })
    return getStatus()
  }

  function saveManualConfig(input: OnePasswordManualConfigInput): OnePasswordStatus {
    const extension = validateExtensionPath(input.extensionPath)
    if (!extension.valid) throw new Error(extension.error ?? 'Invalid 1Password extension path')
    if (input.nativeHostManifestPath && !path.isAbsolute(input.nativeHostManifestPath)) {
      throw new Error('Native host manifest path must be absolute')
    }
    const config: OnePasswordDesktopConfig = {
      enabled: true,
      extensionId: env.KAIVO_1PASSWORD_EXTENSION_ID?.trim() || ONEPASSWORD_EXTENSION_ID,
      extensionPath: input.extensionPath,
      extensionSource: 'manual',
      nativeHostManifestPath: input.nativeHostManifestPath || undefined,
      updatedAt: new Date().toISOString(),
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    return getStatus()
  }

  async function install(): Promise<OnePasswordInstallResult> {
    const extensionId = env.KAIVO_1PASSWORD_EXTENSION_ID?.trim() || ONEPASSWORD_EXTENSION_ID
    const downloadUrl = env.KAIVO_1PASSWORD_DOWNLOAD_URL?.trim() || onePasswordDownloadUrl(extensionId)
    fs.mkdirSync(rootDir, { recursive: true })
    const tempDir = fs.mkdtempSync(path.join(rootDir, 'tmp-1password-install-'))
    const packagePath = path.join(tempDir, 'extension.crx')
    const zipPath = path.join(tempDir, 'extension.zip')
    const unpackDir = path.join(tempDir, 'unpacked')

    try {
      await downloadToFile(downloadUrl, packagePath)
      const packageInfo = prepareZipForExtraction(packagePath, zipPath, extensionId)
      fs.mkdirSync(unpackDir, { recursive: true })
      execFileSync('unzip', ['-q', zipPath, '-d', unpackDir])
      const manifest = readExtensionManifest(unpackDir)
      if (!manifest.key && packageInfo.publicKey) {
        writeExtensionManifest(unpackDir, { ...manifest, key: packageInfo.publicKey })
      }
      if (!isOnePasswordManifest(unpackDir, manifest)) {
        throw new Error('Downloaded extension manifest is not 1Password')
      }
      const version = typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : 'unknown'
      const installDir = path.join(rootDir, 'extensions', '1password', version)
      fs.rmSync(installDir, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(installDir), { recursive: true })
      fs.renameSync(unpackDir, installDir)
      const config: OnePasswordDesktopConfig = {
        enabled: true,
        extensionId,
        extensionPath: installDir,
        extensionSource: 'downloaded',
        nativeHostManifestPath: resolveNativeHostManifestPath(undefined, homeDir),
        updatedAt: new Date().toISOString(),
      }
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
      return { status: getStatus() }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }

  function getWebFrameOptions(): OnePasswordWebFrameOptions {
    const status = getStatus()
    if (status.state !== 'extension-installed' && status.state !== 'ready') return {}
    if (!status.extensionPath) return {}
    const options: OnePasswordWebFrameOptions = {
      extensions: [{ path: status.extensionPath, allowFileAccess: true }],
      chromeExtensions: { enabled: true, license: 'GPL-3.0' },
    }
    if (status.nativeHostState === 'valid' && status.nativeHostManifestPath) {
      options.nativeMessaging = {
        hosts: [
          {
            manifestPath: status.nativeHostManifestPath,
            hostName: 'com.1password.1password',
            allowedExtensionIds: [status.extensionId],
          },
          {
            manifestPath: status.nativeHostManifestPath,
            hostName: 'com.1password.1password7',
            allowedExtensionIds: [status.extensionId],
          },
        ],
      }
    }
    return options
  }

  function setRuntimeLoadError(error: string | undefined): void {
    runtimeLoadError = error
  }

  return { getStatus, resetConfig, saveManualConfig, install, getWebFrameOptions, setRuntimeLoadError }
}

export function onePasswordDownloadUrl(extensionId = ONEPASSWORD_EXTENSION_ID, chromeVersion = process.versions.chrome): string {
  const update = new URL('https://clients2.google.com/service/update2/crx')
  update.searchParams.set('response', 'redirect')
  update.searchParams.set('prodversion', chromeUpdateProdVersion(chromeVersion))
  update.searchParams.set('acceptformat', 'crx3')
  update.searchParams.set('x', `id=${extensionId}&installsource=ondemand&uc`)
  return update.toString()
}

export function chromeUpdateProdVersion(chromeVersion: string | undefined): string {
  const fallback = '130.0.0.0'
  if (!chromeVersion) return fallback
  const major = Number(chromeVersion.split('.')[0])
  if (!Number.isFinite(major) || major < 130) return fallback
  return chromeVersion
}

export function resolveOnePasswordTriggerTabId(input: { browserTabId?: string } | undefined, lastFocusedBrowserTabId: string | undefined): string {
  const browserTabId = input?.browserTabId?.trim() || lastFocusedBrowserTabId
  if (!browserTabId) throw new Error('Focus a browser pane before opening 1Password')
  return browserTabId
}

export function onePasswordConfigPath(instance: Pick<InstanceRuntimeConfig, 'rootDir'>): string {
  return path.join(instance.rootDir, 'desktop-1password.json')
}

export function validateExtensionPath(extensionPath: string | undefined): { valid: boolean; version?: string; error?: string } {
  if (!extensionPath) return { valid: false }
  if (!path.isAbsolute(extensionPath)) return { valid: false, error: 'Extension path must be absolute' }
  try {
    const stat = fs.statSync(extensionPath)
    if (!stat.isDirectory()) return { valid: false, error: 'Extension path must be a directory' }
  } catch {
    return { valid: false, error: 'Extension path does not exist' }
  }

  try {
    const manifest = readExtensionManifest(extensionPath)
    return { valid: true, version: typeof manifest.version === 'string' ? manifest.version : undefined }
  } catch {
    return { valid: false, error: 'Extension directory must contain a valid manifest.json' }
  }
}

export function prepareZipForExtraction(packagePath: string, zipPath: string, expectedExtensionId = ONEPASSWORD_EXTENSION_ID): { publicKey?: string } {
  const data = fs.readFileSync(packagePath)
  if (data.slice(0, 4).toString('utf8') === '<!do' || data.slice(0, 5).toString('utf8').toLowerCase() === '<html') {
    throw new Error('Downloaded extension package was HTML, not a CRX or ZIP file')
  }
  if (data.slice(0, 2).toString('binary') === 'PK') {
    fs.writeFileSync(zipPath, data)
    return {}
  }
  if (data.slice(0, 4).toString('utf8') !== 'Cr24') throw new Error('Downloaded extension package is not a CRX or ZIP file')
  const version = data.readUInt32LE(4)
  let publicKey: string | undefined
  let zipOffset: number
  if (version === 2) {
    const publicKeyLength = data.readUInt32LE(8)
    const publicKeyBytes = data.subarray(16, 16 + publicKeyLength)
    publicKey = publicKeyBytes.toString('base64')
    zipOffset = 16 + publicKeyLength + data.readUInt32LE(12)
  } else if (version === 3) {
    const header = data.subarray(12, 12 + data.readUInt32LE(8))
    publicKey = findCrx3PublicKey(header, expectedExtensionId)
    zipOffset = 12 + data.readUInt32LE(8)
  } else {
    throw new Error(`Unsupported CRX version ${version}`)
  }
  if (zipOffset >= data.length) throw new Error('CRX package does not contain ZIP payload')
  fs.writeFileSync(zipPath, data.subarray(zipOffset))
  return { publicKey }
}

export function redactOnePasswordDiagnostics(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((item) => redactOnePasswordDiagnostics(item))
  if (!input || typeof input !== 'object') return input
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (/payload|message|secret|token|password|authorization/i.test(key)) {
      out[key] = '[redacted]'
    } else {
      out[key] = redactOnePasswordDiagnostics(value)
    }
  }
  return out
}

function isOnePasswordManifest(extensionPath: string, manifest: { name?: unknown; short_name?: unknown; default_locale?: unknown }): boolean {
  const candidates = [manifest.name, manifest.short_name]
  if (typeof manifest.name === 'string' && manifest.name.startsWith('__MSG_') && typeof manifest.default_locale === 'string') {
    const messageName = manifest.name.slice('__MSG_'.length, -'__'.length)
    const messagesPath = path.join(extensionPath, '_locales', manifest.default_locale, 'messages.json')
    try {
      const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8')) as Record<string, { message?: unknown }>
      candidates.push(messages[messageName]?.message)
    } catch {
      // Fall back to other manifest fields.
    }
  }
  return candidates.some((candidate) => typeof candidate === 'string' && candidate.toLowerCase().includes('1password'))
}

function readExtensionManifest(extensionPath: string): { name?: unknown; short_name?: unknown; default_locale?: unknown; version?: unknown; key?: unknown } {
  return JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8')) as {
    name?: unknown
    short_name?: unknown
    default_locale?: unknown
    version?: unknown
    key?: unknown
  }
}

function writeExtensionManifest(extensionPath: string, manifest: { [key: string]: unknown }): void {
  fs.writeFileSync(path.join(extensionPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function findCrx3PublicKey(header: Buffer, expectedExtensionId: string): string | undefined {
  const keys: Buffer[] = []
  for (const proof of readLengthDelimitedFields(header, 2)) {
    keys.push(...readLengthDelimitedFields(proof, 1))
  }
  const matching = keys.find((key) => extensionIdFromPublicKey(key) === expectedExtensionId)
  return (matching ?? keys[0])?.toString('base64')
}

function readLengthDelimitedFields(buffer: Buffer, targetField: number): Buffer[] {
  const values: Buffer[] = []
  let offset = 0
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset)
    if (!tag) break
    offset = tag.offset
    const field = tag.value >> 3
    const wire = tag.value & 7
    if (wire === 2) {
      const length = readVarint(buffer, offset)
      if (!length) break
      offset = length.offset
      const end = offset + length.value
      if (end > buffer.length) break
      const value = buffer.subarray(offset, end)
      if (field === targetField) values.push(value)
      offset = end
    } else if (wire === 0) {
      const value = readVarint(buffer, offset)
      if (!value) break
      offset = value.offset
    } else if (wire === 5) {
      offset += 4
    } else if (wire === 1) {
      offset += 8
    } else {
      break
    }
  }
  return values
}

function readVarint(buffer: Buffer, offset: number): { value: number; offset: number } | null {
  let value = 0
  let shift = 0
  let current = offset
  while (current < buffer.length && shift < 35) {
    const byte = buffer[current++] ?? 0
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, offset: current }
    shift += 7
  }
  return null
}

function extensionIdFromPublicKey(publicKey: Buffer): string {
  const hash = createHash('sha256').update(publicKey).digest().subarray(0, 16)
  return Array.from(hash, (byte) => {
    const high = String.fromCharCode('a'.charCodeAt(0) + (byte >> 4))
    const low = String.fromCharCode('a'.charCodeAt(0) + (byte & 15))
    return `${high}${low}`
  }).join('')
}

async function downloadToFile(url: string, outputPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const parsed = new URL(url)
  if (parsed.protocol === 'file:') {
    fs.copyFileSync(parsed, outputPath)
    return
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('1Password download URL must be http, https, or file')
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`1Password extension download failed: ${response.status} ${response.statusText}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw new Error('1Password extension download returned an empty response; Chrome Web Store may require a newer prodversion')
  fs.writeFileSync(outputPath, buffer)
}

export function defaultNativeHostManifestPath(homeDir: string | undefined): string | undefined {
  if (process.platform !== 'darwin' || !homeDir) return undefined
  return path.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', 'com.1password.1password.json')
}

export function validateNativeHostManifest(manifestPath: string | undefined, extensionId: string): {
  state: 'missing' | 'valid' | 'invalid'
  manifestPath?: string
  message?: string
} {
  if (!manifestPath) return { state: 'missing' }
  if (!path.isAbsolute(manifestPath)) return { state: 'invalid', manifestPath, message: 'Native host manifest path must be absolute' }
  if (!fs.existsSync(manifestPath)) return { state: 'missing', manifestPath, message: 'Native host manifest not found' }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      type?: unknown
      path?: unknown
      allowed_origins?: unknown
    }
    if (parsed.type !== 'stdio') return { state: 'invalid', manifestPath, message: 'Native host manifest type must be stdio' }
    if (typeof parsed.path !== 'string' || !path.isAbsolute(parsed.path)) {
      return { state: 'invalid', manifestPath, message: 'Native host executable path must be absolute' }
    }
    if (!Array.isArray(parsed.allowed_origins) || !parsed.allowed_origins.includes(`chrome-extension://${extensionId}/`)) {
      return { state: 'invalid', manifestPath, message: `Native host must allow chrome-extension://${extensionId}/` }
    }
    return { state: 'valid', manifestPath }
  } catch {
    return { state: 'invalid', manifestPath, message: 'Native host manifest must be valid JSON' }
  }
}

function resolveNativeHostManifestPath(configuredPath: string | undefined, homeDir: string | undefined): string | undefined {
  return configuredPath ?? defaultNativeHostManifestPath(homeDir)
}

function resolveOnePasswordConfig(configPath: string, env: NodeJS.ProcessEnv): ResolvedOnePasswordConfig {
  const persisted = readConfig(configPath)
  const envExtensionPath = clean(env.KAIVO_1PASSWORD_EXTENSION_PATH)
  const envNativeHostManifestPath = clean(env.KAIVO_1PASSWORD_NATIVE_HOST_MANIFEST)
  const extensionId = clean(env.KAIVO_1PASSWORD_EXTENSION_ID) ?? persisted?.extensionId ?? ONEPASSWORD_EXTENSION_ID

  return {
    enabled: Boolean(envExtensionPath || persisted?.enabled),
    extensionId,
    extensionPath: envExtensionPath ?? persisted?.extensionPath,
    extensionSource: envExtensionPath ? 'env' : persisted?.extensionSource,
    nativeHostManifestPath: envNativeHostManifestPath ?? persisted?.nativeHostManifestPath,
  }
}

function readConfig(configPath: string): OnePasswordDesktopConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<OnePasswordDesktopConfig>
    return {
      enabled: parsed.enabled === true,
      extensionId: typeof parsed.extensionId === 'string' && parsed.extensionId.trim() ? parsed.extensionId : ONEPASSWORD_EXTENSION_ID,
      extensionPath: typeof parsed.extensionPath === 'string' ? parsed.extensionPath : undefined,
      extensionSource: parsed.extensionSource === 'downloaded' || parsed.extensionSource === 'manual' ? parsed.extensionSource : undefined,
      nativeHostManifestPath: typeof parsed.nativeHostManifestPath === 'string' ? parsed.nativeHostManifestPath : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}
