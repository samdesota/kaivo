import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ONEPASSWORD_EXTENSION_ID } from '../../../shared/desktop-onepassword'
import {
  createOnePasswordRuntime,
  chromeUpdateProdVersion,
  onePasswordDownloadUrl,
  onePasswordConfigPath,
  prepareZipForExtraction,
  redactOnePasswordDiagnostics,
  resolveOnePasswordTriggerTabId,
  validateExtensionPath,
  validateNativeHostManifest,
} from './onepassword'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaivo-1password-test-'))
  tempDirs.push(dir)
  return dir
}

function makeExtension(root = tempRoot()): string {
  const extensionPath = path.join(root, 'extension')
  fs.mkdirSync(extensionPath, { recursive: true })
  fs.writeFileSync(path.join(extensionPath, 'manifest.json'), JSON.stringify({ name: '1Password', version: '1.2.3' }))
  return extensionPath
}

function makeNativeHostManifest(root = tempRoot(), extensionId = ONEPASSWORD_EXTENSION_ID): string {
  const manifestPath = path.join(root, 'com.1password.1password.json')
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: 'com.1password.1password',
    path: process.execPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }))
  return manifestPath
}

function makeExtensionZip(name = '1Password', version = '8.0.0'): string {
  const root = tempRoot()
  const sourceDir = path.join(root, 'source')
  const zipPath = path.join(root, 'extension.zip')
  fs.mkdirSync(sourceDir, { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name, version }))
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceDir })
  return zipPath
}

function makeLocalizedExtensionZip(): string {
  const root = tempRoot()
  const sourceDir = path.join(root, 'source')
  const zipPath = path.join(root, 'extension.zip')
  fs.mkdirSync(path.join(sourceDir, '_locales', 'en'), { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: '__MSG_extName__',
    short_name: '1Password',
    default_locale: 'en',
    version: '8.12.26.40',
  }))
  fs.writeFileSync(path.join(sourceDir, '_locales', 'en', 'messages.json'), JSON.stringify({
    extName: { message: '1Password - Password Manager' },
  }))
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: sourceDir })
  return zipPath
}

function extensionIdFromTestKey(publicKey: Buffer): string {
  const hash = createHash('sha256').update(publicKey).digest().subarray(0, 16)
  return Array.from(hash, (byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join('')
}

function varint(value: number): Buffer {
  const bytes: number[] = []
  let next = value
  do {
    let byte = next & 0x7f
    next >>>= 7
    if (next) byte |= 0x80
    bytes.push(byte)
  } while (next)
  return Buffer.from(bytes)
}

function lengthDelimited(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value])
}

function makeCrx3Package(zipPath: string, publicKey: Buffer): string {
  const root = tempRoot()
  const crxPath = path.join(root, 'extension.crx')
  const proof = lengthDelimited(1, publicKey)
  const headerPayload = lengthDelimited(2, proof)
  const header = Buffer.alloc(12)
  header.write('Cr24', 0, 'utf8')
  header.writeUInt32LE(3, 4)
  header.writeUInt32LE(headerPayload.length, 8)
  fs.writeFileSync(crxPath, Buffer.concat([header, headerPayload, fs.readFileSync(zipPath)]))
  return crxPath
}

describe('1Password desktop runtime', () => {
  it('returns default not-installed status when no config or env overrides exist', () => {
    const rootDir = tempRoot()
    const runtime = createOnePasswordRuntime({ instance: { rootDir }, env: {}, homeDir: tempRoot() })

    expect(runtime.getStatus()).toMatchObject({
      available: true,
      state: 'not-installed',
      enabled: false,
      extensionId: ONEPASSWORD_EXTENSION_ID,
      nativeHostState: 'missing',
      requiresRestart: false,
    })
  })

  it('reports env-sourced values without writing them into persisted config', () => {
    const rootDir = tempRoot()
    const extensionPath = makeExtension()
    const runtime = createOnePasswordRuntime({
      instance: { rootDir },
      env: { KAIVO_1PASSWORD_EXTENSION_PATH: extensionPath },
      homeDir: tempRoot(),
    })

    expect(runtime.getStatus()).toMatchObject({
      state: 'extension-installed',
      enabled: true,
      extensionPath,
      extensionSource: 'env',
      extensionVersion: '1.2.3',
    })
    expect(fs.existsSync(onePasswordConfigPath({ rootDir }))).toBe(false)
  })

  it('reset removes persisted 1Password config and returns default status', () => {
    const rootDir = tempRoot()
    const extensionPath = makeExtension()
    const runtime = createOnePasswordRuntime({ instance: { rootDir }, env: {}, homeDir: tempRoot() })
    runtime.saveManualConfig({ extensionPath })

    expect(fs.existsSync(onePasswordConfigPath({ rootDir }))).toBe(true)
    expect(runtime.resetConfig()).toMatchObject({ state: 'not-installed', enabled: false })
    expect(fs.existsSync(onePasswordConfigPath({ rootDir }))).toBe(false)
  })

  it('extension path validation rejects relative paths, missing directories, and directories without manifest.json', () => {
    const rootDir = tempRoot()
    const emptyDir = path.join(rootDir, 'empty')
    fs.mkdirSync(emptyDir)

    expect(validateExtensionPath('relative/path')).toMatchObject({ valid: false, error: 'Extension path must be absolute' })
    expect(validateExtensionPath(path.join(rootDir, 'missing'))).toMatchObject({ valid: false, error: 'Extension path does not exist' })
    expect(validateExtensionPath(emptyDir)).toMatchObject({ valid: false, error: 'Extension directory must contain a valid manifest.json' })
  })

  it('emits WebFrame extension options only for valid enabled config', () => {
    const rootDir = tempRoot()
    const extensionPath = makeExtension()
    const runtime = createOnePasswordRuntime({ instance: { rootDir }, env: {}, homeDir: tempRoot() })

    expect(runtime.getWebFrameOptions()).toEqual({})
    runtime.saveManualConfig({ extensionPath })
    expect(runtime.getWebFrameOptions()).toEqual({
      extensions: [{ path: extensionPath, allowFileAccess: true }],
      chromeExtensions: { enabled: true, license: 'GPL-3.0' },
    })
  })

  it('trigger tab resolution returns a clear error when no browser tab is focused or supplied', () => {
    expect(() => resolveOnePasswordTriggerTabId(undefined, undefined)).toThrow('Focus a browser pane before opening 1Password')
    expect(resolveOnePasswordTriggerTabId({ browserTabId: 'tab-explicit' }, undefined)).toBe('tab-explicit')
    expect(resolveOnePasswordTriggerTabId(undefined, 'tab-focused')).toBe('tab-focused')
  })

  it('native host validation accepts a valid fixture manifest with the pinned extension origin', () => {
    const manifestPath = makeNativeHostManifest()

    expect(validateNativeHostManifest(manifestPath, ONEPASSWORD_EXTENSION_ID)).toEqual({
      state: 'valid',
      manifestPath,
    })
  })

  it('native host validation rejects invalid manifests', () => {
    const rootDir = tempRoot()
    const relativeManifest = 'NativeMessagingHosts/com.1password.1password.json'
    const wrongType = path.join(rootDir, 'wrong-type.json')
    const relativeExecutable = path.join(rootDir, 'relative-executable.json')
    const missingOrigin = path.join(rootDir, 'missing-origin.json')
    fs.writeFileSync(wrongType, JSON.stringify({ type: 'pipe', path: process.execPath, allowed_origins: [`chrome-extension://${ONEPASSWORD_EXTENSION_ID}/`] }))
    fs.writeFileSync(relativeExecutable, JSON.stringify({ type: 'stdio', path: 'op-host', allowed_origins: [`chrome-extension://${ONEPASSWORD_EXTENSION_ID}/`] }))
    fs.writeFileSync(missingOrigin, JSON.stringify({ type: 'stdio', path: process.execPath, allowed_origins: [] }))

    expect(validateNativeHostManifest(relativeManifest, ONEPASSWORD_EXTENSION_ID)).toMatchObject({ state: 'invalid', message: 'Native host manifest path must be absolute' })
    expect(validateNativeHostManifest(wrongType, ONEPASSWORD_EXTENSION_ID)).toMatchObject({ state: 'invalid', message: 'Native host manifest type must be stdio' })
    expect(validateNativeHostManifest(relativeExecutable, ONEPASSWORD_EXTENSION_ID)).toMatchObject({ state: 'invalid', message: 'Native host executable path must be absolute' })
    expect(validateNativeHostManifest(missingOrigin, ONEPASSWORD_EXTENSION_ID)).toMatchObject({ state: 'invalid', message: `Native host must allow chrome-extension://${ONEPASSWORD_EXTENSION_ID}/` })
  })

  it('registers both current and legacy native messaging host names for a valid manifest', () => {
    const rootDir = tempRoot()
    const extensionPath = makeExtension()
    const nativeHostManifestPath = makeNativeHostManifest()
    const runtime = createOnePasswordRuntime({ instance: { rootDir }, env: {}, homeDir: tempRoot() })
    runtime.saveManualConfig({ extensionPath, nativeHostManifestPath })

    expect(runtime.getStatus()).toMatchObject({ state: 'ready', nativeHostState: 'valid', nativeHostManifestPath })
    expect(runtime.getWebFrameOptions().nativeMessaging).toEqual({
      hosts: [
        { manifestPath: nativeHostManifestPath, hostName: 'com.1password.1password', allowedExtensionIds: [ONEPASSWORD_EXTENSION_ID] },
        { manifestPath: nativeHostManifestPath, hostName: 'com.1password.1password7', allowedExtensionIds: [ONEPASSWORD_EXTENSION_ID] },
      ],
    })
  })

  it('installer uses pinned extension id in the Chrome update URL', () => {
    const url = onePasswordDownloadUrl(ONEPASSWORD_EXTENSION_ID, '142.0.7444.61')

    expect(url).toContain('clients2.google.com/service/update2/crx')
    expect(decodeURIComponent(url)).toContain(`id=${ONEPASSWORD_EXTENSION_ID}`)
    expect(url).toContain('prodversion=142.0.7444.61')
    expect(url).toContain('acceptformat=crx3')
  })

  it('uses a Chrome update prodversion high enough for current Web Store CRX responses', () => {
    expect(chromeUpdateProdVersion(undefined)).toBe('130.0.0.0')
    expect(chromeUpdateProdVersion('120.0.0.0')).toBe('130.0.0.0')
    expect(chromeUpdateProdVersion('142.0.7444.61')).toBe('142.0.7444.61')
  })

  it('rejects malformed downloaded packages before persisting config', async () => {
    const rootDir = tempRoot()
    const badPackage = path.join(rootDir, 'bad.html')
    fs.writeFileSync(badPackage, '<html>nope</html>')
    const extensionPath = makeExtension()
    const runtime = createOnePasswordRuntime({
      instance: { rootDir },
      env: { KAIVO_1PASSWORD_DOWNLOAD_URL: pathToFileURL(badPackage).toString() },
      homeDir: tempRoot(),
    })
    runtime.saveManualConfig({ extensionPath })
    const before = fs.readFileSync(onePasswordConfigPath({ rootDir }), 'utf8')

    await expect(runtime.install()).rejects.toThrow(/HTML|CRX|ZIP/)

    expect(fs.readFileSync(onePasswordConfigPath({ rootDir }), 'utf8')).toBe(before)
  })

  it('successful install writes downloaded config with version and instance-scoped path', async () => {
    const rootDir = tempRoot()
    const zipPath = makeExtensionZip('1Password', '8.12.0')
    const runtime = createOnePasswordRuntime({
      instance: { rootDir },
      env: { KAIVO_1PASSWORD_DOWNLOAD_URL: pathToFileURL(zipPath).toString() },
      homeDir: tempRoot(),
    })

    const result = await runtime.install()

    expect(result.status).toMatchObject({
      state: 'extension-installed',
      extensionSource: 'downloaded',
      extensionVersion: '8.12.0',
    })
    expect(result.status.extensionPath).toBe(path.join(rootDir, 'extensions', '1password', '8.12.0'))
    expect(fs.existsSync(path.join(result.status.extensionPath!, 'manifest.json'))).toBe(true)
  })

  it('accepts localized Chrome Web Store 1Password manifests', async () => {
    const rootDir = tempRoot()
    const zipPath = makeLocalizedExtensionZip()
    const runtime = createOnePasswordRuntime({
      instance: { rootDir },
      env: { KAIVO_1PASSWORD_DOWNLOAD_URL: pathToFileURL(zipPath).toString() },
      homeDir: tempRoot(),
    })

    const result = await runtime.install()

    expect(result.status).toMatchObject({
      state: 'extension-installed',
      extensionSource: 'downloaded',
      extensionVersion: '8.12.26.40',
    })
  })

  it('can strip a CRX3 header before extracting the ZIP payload', () => {
    const rootDir = tempRoot()
    const zipPath = makeExtensionZip()
    const crxPath = path.join(rootDir, 'extension.crx')
    const strippedZipPath = path.join(rootDir, 'stripped.zip')
    const header = Buffer.alloc(12)
    header.write('Cr24', 0, 'utf8')
    header.writeUInt32LE(3, 4)
    header.writeUInt32LE(0, 8)
    fs.writeFileSync(crxPath, Buffer.concat([header, fs.readFileSync(zipPath)]))

    prepareZipForExtraction(crxPath, strippedZipPath)

    expect(fs.readFileSync(strippedZipPath).slice(0, 2).toString('binary')).toBe('PK')
  })

  it('injects CRX public key into installed manifest so Electron preserves the extension id', async () => {
    const rootDir = tempRoot()
    const publicKey = Buffer.from('test-public-key-for-extension-id')
    const extensionId = extensionIdFromTestKey(publicKey)
    const crxPath = makeCrx3Package(makeLocalizedExtensionZip(), publicKey)
    const runtime = createOnePasswordRuntime({
      instance: { rootDir },
      env: {
        KAIVO_1PASSWORD_EXTENSION_ID: extensionId,
        KAIVO_1PASSWORD_DOWNLOAD_URL: pathToFileURL(crxPath).toString(),
      },
      homeDir: tempRoot(),
    })

    const result = await runtime.install()
    const manifest = JSON.parse(fs.readFileSync(path.join(result.status.extensionPath!, 'manifest.json'), 'utf8')) as { key?: string }

    expect(manifest.key).toBe(publicKey.toString('base64'))
    expect(result.status.extensionId).toBe(extensionId)
  })

  it('redacts native messaging payloads and secret-like diagnostic values', () => {
    expect(redactOnePasswordDiagnostics({
      hostName: 'com.1password.1password',
      nativePayload: { vaultItem: 'secret' },
      nested: { accessToken: 'abc', ok: true },
    })).toEqual({
      hostName: 'com.1password.1password',
      nativePayload: '[redacted]',
      nested: { accessToken: '[redacted]', ok: true },
    })
  })
})
