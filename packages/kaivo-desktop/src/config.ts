import { desktopAuthExchangeUrl, resolveInstanceRuntimeConfig, type InstanceRuntimeConfig, type ResolveInstanceRuntimeOptions } from './instance-runtime'

export type DesktopMode = 'development' | 'production'

export type DesktopConfig = {
  mode: DesktopMode
  chromeUrl: string
  manageServices: boolean
  instance: InstanceRuntimeConfig
}

export function resolveDesktopConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveInstanceRuntimeOptions = {},
): DesktopConfig {
  const mode: DesktopMode = env.NODE_ENV === 'production' ? 'production' : 'development'
  const instance = resolveInstanceRuntimeConfig(env, { ...options, mode })
  const manageServices = env.CC_DESKTOP_MANAGE_SERVICES
    ? env.CC_DESKTOP_MANAGE_SERVICES === 'true'
    : mode === 'production'
  const baseChromeUrl =
    env.CC_DESKTOP_CHROME_URL ??
    (mode === 'production' ? env.CC_DESKTOP_PROD_URL : undefined) ??
    (manageServices
      ? instance.app.url
      : undefined) ??
    (mode === 'development'
      ? env.CC_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5180'
      : instance.app.url)
  const chromeUrl = env.CC_DESKTOP_AUTH_TOKEN && sameOrigin(baseChromeUrl, instance.app.url)
    ? desktopAuthExchangeUrl(instance.app.url, env.CC_DESKTOP_AUTH_TOKEN, baseChromeUrl)
    : baseChromeUrl

  return { mode, chromeUrl, manageServices, instance }
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}
