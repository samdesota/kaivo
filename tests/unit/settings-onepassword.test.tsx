// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OnePasswordSection } from '../../src/routes/settings/onepassword'
import type { OnePasswordStatus } from '../../shared/desktop-onepassword'

afterEach(() => {
  cleanup()
  delete (window as any).cloudCodeDesktop
})

describe('OnePasswordSection', () => {
  it('renders unavailable messaging when desktop 1Password methods are absent', () => {
    render(<OnePasswordSection />)

    expect(screen.getByText('Desktop support unavailable')).toBeTruthy()
    expect(screen.getByText('1Password extension support is only available in the desktop app.')).toBeTruthy()
  })

  it('loads desktop status when the preload API is available', async () => {
    const status: OnePasswordStatus = {
      available: true,
      state: 'not-installed',
      enabled: false,
      extensionId: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa',
      nativeHostState: 'missing',
      requiresRestart: false,
    }
    ;(window as any).cloudCodeDesktop = {
      getOnePasswordStatus: vi.fn(async () => status),
      resetOnePasswordConfig: vi.fn(async () => status),
    }

    render(<OnePasswordSection />)

    await waitFor(() => expect(screen.getByText('1Password is not installed in Kaivo')).toBeTruthy())
  })

  it('saves manual path and reports restart-required state', async () => {
    const initial: OnePasswordStatus = {
      available: true,
      state: 'not-installed',
      enabled: false,
      extensionId: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa',
      nativeHostState: 'missing',
      requiresRestart: false,
    }
    const saved: OnePasswordStatus = {
      ...initial,
      state: 'extension-installed',
      enabled: true,
      extensionPath: '/tmp/1password-extension',
      extensionSource: 'manual',
    }
    const saveOnePasswordConfig = vi.fn(async () => saved)
    ;(window as any).cloudCodeDesktop = {
      getOnePasswordStatus: vi.fn(async () => initial),
      resetOnePasswordConfig: vi.fn(async () => initial),
      saveOnePasswordConfig,
    }

    render(<OnePasswordSection />)

    const input = await screen.findByPlaceholderText('/absolute/path/to/1Password/extension')
    fireEvent.change(input, { target: { value: '/tmp/1password-extension' } })
    fireEvent.click(screen.getByText('Save manual path'))

    await waitFor(() => expect(saveOnePasswordConfig).toHaveBeenCalledWith({ extensionPath: '/tmp/1password-extension', nativeHostManifestPath: undefined }))
    await waitFor(() => expect(screen.getByText('Restart required')).toBeTruthy())
  })

  it('calls trigger action from the test button when extension status is loaded', async () => {
    const status: OnePasswordStatus = {
      available: true,
      state: 'extension-installed',
      enabled: true,
      extensionId: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa',
      extensionPath: '/tmp/1password-extension',
      extensionSource: 'manual',
      nativeHostState: 'missing',
      requiresRestart: false,
    }
    const triggerOnePassword = vi.fn(async () => ({ ok: true as const }))
    ;(window as any).cloudCodeDesktop = {
      getOnePasswordStatus: vi.fn(async () => status),
      resetOnePasswordConfig: vi.fn(async () => status),
      triggerOnePassword,
    }

    render(<OnePasswordSection />)

    await screen.findByText('1Password extension is installed')
    fireEvent.click(screen.getByText('Open/Test 1Password'))

    await waitFor(() => expect(triggerOnePassword).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('1Password action triggered.')).toBeTruthy())
  })

  it('runs install action and reports restart-required state', async () => {
    const initial: OnePasswordStatus = {
      available: true,
      state: 'not-installed',
      enabled: false,
      extensionId: 'aeblfdkhhhdcdjpifhhbdiojplfjncoa',
      nativeHostState: 'missing',
      requiresRestart: false,
    }
    const installed: OnePasswordStatus = {
      ...initial,
      state: 'extension-installed',
      enabled: true,
      extensionPath: '/tmp/kaivo/extensions/1password/8.12.0',
      extensionSource: 'downloaded',
      extensionVersion: '8.12.0',
    }
    const installOnePassword = vi.fn(async () => ({ status: installed }))
    ;(window as any).cloudCodeDesktop = {
      getOnePasswordStatus: vi.fn(async () => initial),
      installOnePassword,
      resetOnePasswordConfig: vi.fn(async () => initial),
    }

    render(<OnePasswordSection />)

    await screen.findByText('Install 1Password')
    fireEvent.click(screen.getByText('Install 1Password'))

    await waitFor(() => expect(installOnePassword).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText('Restart required')).toBeTruthy())
  })
})
