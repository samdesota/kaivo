import { useEffect, useState } from 'react'
import { Button, FormError, Input } from '../../components/ui'
import { extractTrpcMessage } from '../../lib/utils'
import { SettingsPanel } from './panel'
import type { OnePasswordStatus } from '../../../shared/desktop-onepassword'

type OnePasswordDesktopApi = {
  getOnePasswordStatus?: () => Promise<OnePasswordStatus>
  installOnePassword?: () => Promise<{ status: OnePasswordStatus }>
  resetOnePasswordConfig?: () => Promise<OnePasswordStatus>
  saveOnePasswordConfig?: (input: { extensionPath: string; nativeHostManifestPath?: string }) => Promise<OnePasswordStatus>
  triggerOnePassword?: () => Promise<{ ok: true }>
}

type OnePasswordWindow = Window & {
  cloudCodeDesktop?: OnePasswordDesktopApi
}

const unavailableStatus: OnePasswordStatus = {
  available: false,
  state: 'unavailable',
  enabled: false,
  extensionId: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa',
  nativeHostState: 'missing',
  requiresRestart: false,
}

export function OnePasswordSection() {
  const desktop = (window as OnePasswordWindow).cloudCodeDesktop
  const getStatus = desktop?.getOnePasswordStatus
  const installOnePassword = desktop?.installOnePassword
  const resetConfig = desktop?.resetOnePasswordConfig
  const saveConfig = desktop?.saveOnePasswordConfig
  const triggerOnePassword = desktop?.triggerOnePassword
  const [status, setStatus] = useState<OnePasswordStatus>(() => getStatus ? unavailableStatus : unavailableStatus)
  const [extensionPath, setExtensionPath] = useState('')
  const [nativeHostManifestPath, setNativeHostManifestPath] = useState('')
  const [pending, setPending] = useState(false)
  const [installPending, setInstallPending] = useState(false)
  const [testPending, setTestPending] = useState(false)
  const [testStatus, setTestStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!getStatus) {
      setStatus(unavailableStatus)
      return
    }
    setPending(true)
    getStatus()
      .then((next) => {
        if (!cancelled) setStatus(next)
        if (!cancelled) setExtensionPath(next.extensionPath ?? '')
        if (!cancelled) setNativeHostManifestPath(next.nativeHostManifestPath ?? '')
      })
      .catch((err) => {
        if (!cancelled) setError(extractTrpcMessage(err))
      })
      .finally(() => {
        if (!cancelled) setPending(false)
      })
    return () => {
      cancelled = true
    }
  }, [getStatus])

  async function onRefresh() {
    if (!getStatus) return
    setPending(true)
    setError(null)
    try {
      const next = await getStatus()
      setStatus(next)
      setExtensionPath(next.extensionPath ?? '')
      setNativeHostManifestPath(next.nativeHostManifestPath ?? '')
    } catch (err) {
      setError(extractTrpcMessage(err))
    } finally {
      setPending(false)
    }
  }

  async function onReset() {
    if (!resetConfig) return
    setPending(true)
    setError(null)
    try {
      const next = await resetConfig()
      setStatus(next)
      setExtensionPath('')
      setNativeHostManifestPath('')
    } catch (err) {
      setError(extractTrpcMessage(err))
    } finally {
      setPending(false)
    }
  }

  async function onSaveManual() {
    if (!saveConfig) return
    setPending(true)
    setError(null)
    setTestStatus(null)
    try {
      const next = await saveConfig({
        extensionPath: extensionPath.trim(),
        nativeHostManifestPath: nativeHostManifestPath.trim() || undefined,
      })
      setStatus({ ...next, requiresRestart: true, state: next.state === 'error' ? 'error' : 'needs-restart' })
      setExtensionPath(next.extensionPath ?? '')
      setNativeHostManifestPath(next.nativeHostManifestPath ?? '')
    } catch (err) {
      setError(extractTrpcMessage(err))
    } finally {
      setPending(false)
    }
  }

  async function onInstall() {
    if (!installOnePassword) return
    setInstallPending(true)
    setError(null)
    setTestStatus(null)
    try {
      const result = await installOnePassword()
      setStatus({ ...result.status, requiresRestart: true, state: result.status.state === 'error' ? 'error' : 'needs-restart' })
      setExtensionPath(result.status.extensionPath ?? '')
      setNativeHostManifestPath(result.status.nativeHostManifestPath ?? '')
    } catch (err) {
      setError(extractTrpcMessage(err))
    } finally {
      setInstallPending(false)
    }
  }

  async function onTest() {
    if (!triggerOnePassword) return
    setTestPending(true)
    setError(null)
    setTestStatus(null)
    try {
      await triggerOnePassword()
      setTestStatus('1Password action triggered.')
    } catch (err) {
      setError(extractTrpcMessage(err))
    } finally {
      setTestPending(false)
    }
  }

  return (
    <SettingsPanel
      id="onepassword"
      title="1Password"
      description="Use the 1Password browser extension in Kaivo desktop browser panes. Kaivo hosts the extension; it does not read vault secrets."
    >
      <div className="space-y-3 text-xs">
        <div className="rounded border border-neutral-800 bg-neutral-900/50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="font-medium text-content-default">{statusLabel(status)}</div>
              <div className="mt-1 text-help">{statusDescription(status)}</div>
            </div>
            <span className={statusBadgeClass(status)}>{status.state}</span>
          </div>
          <dl className="mt-3 grid gap-1 text-ui-default">
            <StatusRow label="Extension id" value={status.extensionId} />
            <StatusRow label="Extension path" value={status.extensionPath ?? 'Not configured'} />
            <StatusRow label="Extension source" value={status.extensionSource ?? 'None'} />
            <StatusRow label="Native host" value={status.nativeHostManifestPath ?? 'Not configured'} />
            <StatusRow label="Native host state" value={status.nativeHostState} />
          </dl>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void onInstall()} disabled={!installOnePassword || installPending} variant="primary">
            {installPending ? 'Installing...' : status.extensionSource === 'downloaded' ? 'Reinstall or update' : 'Install 1Password'}
          </Button>
          <Button onClick={() => void onRefresh()} disabled={!getStatus || pending} variant="secondary">
            {pending ? 'Checking...' : 'Refresh'}
          </Button>
          <Button onClick={() => void onReset()} disabled={!resetConfig || pending} variant="ghost">
            Reset local config
          </Button>
        </div>
        <div className="space-y-2 rounded border border-neutral-800 bg-neutral-950 p-3">
          <label className="block space-y-1">
            <span className="text-label">Manual extension directory</span>
            <Input
              value={extensionPath}
              onChange={(event) => setExtensionPath(event.target.value)}
              placeholder="/absolute/path/to/1Password/extension"
              className="font-mono"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-label">Native host manifest</span>
            <Input
              value={nativeHostManifestPath}
              onChange={(event) => setNativeHostManifestPath(event.target.value)}
              placeholder="/absolute/path/to/com.1password.1password.json"
              className="font-mono"
            />
          </label>
          <div className="flex gap-2">
            <Button onClick={() => void onSaveManual()} disabled={!saveConfig || pending || !extensionPath.trim()} variant="secondary">
              Save manual path
            </Button>
            <Button onClick={() => void onTest()} disabled={!triggerOnePassword || testPending || (status.state !== 'extension-installed' && status.state !== 'ready')} variant="secondary">
              {testPending ? 'Opening...' : 'Open/Test 1Password'}
            </Button>
          </div>
        </div>
        {!getStatus && <p className="text-help">1Password extension support is only available in the desktop app.</p>}
        {status.requiresRestart && <p className="text-amber-300">Restart Kaivo desktop to apply this 1Password configuration.</p>}
        {status.nativeHostMessage && <p className="text-amber-300">{status.nativeHostMessage}</p>}
        {testStatus && <p className="text-emerald-400">{testStatus}</p>}
        {(error || status.error) && <FormError>{error ?? status.error}</FormError>}
      </div>
    </SettingsPanel>
  )
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
      <dt className="text-label">{label}</dt>
      <dd className="truncate font-mono text-content-default" title={value}>{value}</dd>
    </div>
  )
}

function statusLabel(status: OnePasswordStatus): string {
  if (status.state === 'unavailable') return 'Desktop support unavailable'
  if (status.state === 'not-installed') return '1Password is not installed in Kaivo'
  if (status.state === 'extension-installed') return '1Password extension is installed'
  if (status.state === 'ready') return '1Password is ready'
  if (status.state === 'needs-restart') return 'Restart required'
  return '1Password setup needs attention'
}

function statusDescription(status: OnePasswordStatus): string {
  if (status.state === 'unavailable') return 'Open Kaivo in the desktop app to use browser extensions.'
  if (status.state === 'not-installed') return 'Install or configure the 1Password extension to use it in browser panes.'
  if (status.state === 'extension-installed') return 'The extension path is configured. Native app integration will be added separately.'
  if (status.state === 'ready') return 'The extension and native messaging host are configured.'
  if (status.state === 'needs-restart') return 'The saved configuration will apply after a desktop restart.'
  return status.error ?? 'Check the configured paths and try again.'
}

function statusBadgeClass(status: OnePasswordStatus): string {
  const base = 'rounded px-2 py-1 font-mono text-[10px] uppercase tracking-wide '
  if (status.state === 'ready' || status.state === 'extension-installed') return `${base}bg-emerald-950 text-emerald-300`
  if (status.state === 'error') return `${base}bg-red-950 text-red-300`
  if (status.state === 'needs-restart') return `${base}bg-amber-950 text-amber-300`
  return `${base}bg-neutral-800 text-ui-muted`
}
