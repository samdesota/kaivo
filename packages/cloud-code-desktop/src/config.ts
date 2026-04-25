export type DesktopMode = 'development' | 'production'

export type DesktopConfig = {
  mode: DesktopMode
  chromeUrl: string
}

export function resolveDesktopConfig(env: NodeJS.ProcessEnv = process.env): DesktopConfig {
  const mode: DesktopMode = env.NODE_ENV === 'production' ? 'production' : 'development'
  const chromeUrl =
    env.CC_DESKTOP_CHROME_URL ??
    (mode === 'development'
      ? env.CC_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5180'
      : env.CC_DESKTOP_PROD_URL ?? `http://127.0.0.1:${env.PORT ?? '3000'}`)

  return { mode, chromeUrl }
}
