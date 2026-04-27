import type { InstanceRuntimeConfig } from './instance-runtime'

export type DesktopPairingResult = {
  envId: string
  envToken: string
  reused: boolean
}

export async function ensureDesktopPairing(config: InstanceRuntimeConfig): Promise<DesktopPairingResult> {
  const envId = `local-${config.instanceId}`
  const [existing, envHealth] = await Promise.all([getRegisteredEnv(config, envId), getEnvHealth(config)])
  if (existing?.envToken && envHealth?.identityReady && await tokenIsValid(config.env.url, existing.envToken)) {
    return { envId, envToken: existing.envToken, reused: true }
  }

  const identityToken = await mintIdentityToken(config)
  const envToken = await mintDesktopToken(config, identityToken)
  await registerEnv(config, envId, envToken)
  return { envId, envToken, reused: false }
}

async function getEnvHealth(config: InstanceRuntimeConfig): Promise<{ identityReady?: boolean } | null> {
  try {
    const response = await fetch(`${config.env.url}/healthz`)
    if (!response.ok) return null
    return (await response.json()) as { identityReady?: boolean }
  } catch {
    return null
  }
}

async function getRegisteredEnv(config: InstanceRuntimeConfig, envId: string): Promise<{ envToken: string } | null> {
  try {
    const response = await fetch(`${config.app.url}/internal/local-env/${encodeURIComponent(envId)}`)
    if (!response.ok) return null
    return (await response.json()) as { envToken: string }
  } catch {
    return null
  }
}

async function registerEnv(config: InstanceRuntimeConfig, envId: string, envToken: string): Promise<void> {
  const response = await fetch(`${config.app.url}/internal/local-env/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: envId,
      label: config.env.label,
      url: config.env.url,
      envToken,
      localIdentityLabel: config.env.label,
    }),
  })
  if (!response.ok) throw new Error(`local env registration failed: ${response.status}`)
}

async function tokenIsValid(envUrl: string, envToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${envUrl}/auth/check`, {
      headers: { authorization: `Bearer ${envToken}` },
    })
    return response.ok
  } catch {
    return false
  }
}

async function mintIdentityToken(config: InstanceRuntimeConfig): Promise<string> {
  const response = await fetch(`${config.app.url}/trpc/envAuth.issueFromService?batch=1`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cc-service-token': process.env.CC_SERVICE_CREDENTIAL ?? 'local-desktop-service-credential',
    },
    body: JSON.stringify({ 0: { json: { label: config.env.label } } }),
  })
  if (!response.ok) throw new Error(`identity token mint failed: ${response.status}`)
  const body = (await response.json()) as Array<{ result?: { data?: { json?: { identityToken?: string } } } }>
  const identityToken = body[0]?.result?.data?.json?.identityToken
  if (!identityToken) throw new Error('identity token mint did not return token')
  return identityToken
}

async function mintDesktopToken(config: InstanceRuntimeConfig, identityToken: string): Promise<string> {
  const response = await fetch(`${config.env.url}/pair/desktop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: config.instanceId, identityToken }),
  })
  if (!response.ok) throw new Error(`desktop pairing failed: ${response.status}`)
  const body = await response.json() as { envToken?: string }
  if (!body.envToken) throw new Error('desktop pairing did not return env token')
  return body.envToken
}
