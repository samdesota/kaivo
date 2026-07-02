export const ONEPASSWORD_EXTENSION_ID = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa'

export type OnePasswordInstallSource = 'downloaded' | 'manual'
export type OnePasswordStatusSource = OnePasswordInstallSource | 'env' | 'discovered'

export type OnePasswordState =
  | 'unavailable'
  | 'not-installed'
  | 'extension-installed'
  | 'ready'
  | 'needs-restart'
  | 'error'

export type OnePasswordDesktopConfig = {
  enabled: boolean
  extensionId: string
  extensionPath?: string
  extensionSource?: OnePasswordInstallSource
  nativeHostManifestPath?: string
  updatedAt: string
}

export type OnePasswordStatus = {
  available: boolean
  state: OnePasswordState
  enabled: boolean
  extensionId: string
  extensionPath?: string
  extensionVersion?: string
  extensionSource?: OnePasswordStatusSource
  nativeHostManifestPath?: string
  nativeHostState: 'missing' | 'valid' | 'invalid'
  nativeHostMessage?: string
  requiresRestart: boolean
  error?: string
}

export type OnePasswordManualConfigInput = {
  extensionPath: string
  nativeHostManifestPath?: string
}

export type OnePasswordInstallResult = {
  status: OnePasswordStatus
}

export type OnePasswordTriggerInput = {
  browserTabId?: string
}

export type OnePasswordTriggerResult = {
  ok: true
}
