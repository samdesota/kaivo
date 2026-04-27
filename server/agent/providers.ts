import { env } from '../env.js'
import { logger } from '../logger.js'
import { getSecret, putSecret } from '../secrets/index.js'
import { db } from '../db/client.js'
import { secrets as secretsTable } from '../db/schema.js'
import { eq } from 'drizzle-orm'

export type ProviderId = 'anthropic' | 'openai'

export const SUPPORTED_PROVIDERS: ProviderId[] = ['anthropic', 'openai']

export interface ProviderConfig {
  provider: ProviderId
  hasApiKey: boolean
  hasBaseUrl: boolean
  baseUrl: string | null
}

interface ProviderEnvBootstrap {
  apiKeyEnv: keyof typeof env
  baseUrlEnv: keyof typeof env
}

const PROVIDER_ENV: Record<ProviderId, ProviderEnvBootstrap> = {
  anthropic: {
    apiKeyEnv: 'ANTHROPIC_API_KEY_BOOTSTRAP',
    baseUrlEnv: 'ANTHROPIC_BASE_URL_BOOTSTRAP',
  },
  openai: {
    apiKeyEnv: 'OPENAI_API_KEY_BOOTSTRAP',
    baseUrlEnv: 'OPENAI_BASE_URL_BOOTSTRAP',
  },
}

function apiKeySecretName(p: ProviderId): string {
  return `provider.${p}.api_key`
}

function baseUrlSecretName(p: ProviderId): string {
  return `provider.${p}.base_url`
}

/**
 * Some local LLM proxies run on the operator's host loopback. Inside a
 * sandbox container, "localhost" is the container itself, so rewrite
 * loopback hosts to `host.docker.internal`. Paired with the sandbox
 * `ExtraHosts: ['host.docker.internal:host-gateway']`, this works on both
 * Docker Desktop and Linux.
 */
export function rewriteLoopbackForSandbox(url: string): string {
  try {
    const u = new URL(url)
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '0.0.0.0') {
      u.hostname = 'host.docker.internal'
    }
    return u.toString()
  } catch {
    return url
  }
}

export function normalizeOpenAIBaseUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.pathname === '' || u.pathname === '/') {
      u.pathname = '/v1'
      return u.toString().replace(/\/$/, '')
    }
    return url.replace(/\/$/, '')
  } catch {
    return url
  }
}

/**
 * Is a row already present under this secret name? We check the `secrets`
 * table directly to avoid needing to decrypt on the read path for the
 * bootstrap precondition.
 */
async function hasSecret(name: string): Promise<boolean> {
  const rows = await db
    .select({ name: secretsTable.name })
    .from(secretsTable)
    .where(eq(secretsTable.name, name))
    .limit(1)
  return rows.length > 0
}

async function deleteSecretRow(name: string): Promise<void> {
  await db.delete(secretsTable).where(eq(secretsTable.name, name))
}

/**
 * On first start: if `<PROVIDER>_API_KEY_BOOTSTRAP` is set and the
 * corresponding secret is absent, encrypt and persist it, then log a note
 * so the operator knows they can unset the env var. Idempotent — on later
 * starts, the stored secret wins and env vars are ignored.
 */
export async function bootstrapProvidersFromEnv(): Promise<void> {
  for (const provider of SUPPORTED_PROVIDERS) {
    const spec = PROVIDER_ENV[provider]
    const envKey = env[spec.apiKeyEnv] as string | undefined
    const envBaseUrl = env[spec.baseUrlEnv] as string | undefined

    if (envKey && !(await hasSecret(apiKeySecretName(provider)))) {
      await putSecret(apiKeySecretName(provider), envKey)
      logger.info(
        { provider },
        `bootstrapped ${provider} api key from env; you can unset ${spec.apiKeyEnv} now`,
      )
    }
    if (envBaseUrl && !(await hasSecret(baseUrlSecretName(provider)))) {
      await putSecret(baseUrlSecretName(provider), envBaseUrl)
      logger.info(
        { provider },
        `bootstrapped ${provider} base url from env; you can unset ${spec.baseUrlEnv} now`,
      )
    }
  }
}

export async function getProviderConfig(provider: ProviderId): Promise<ProviderConfig> {
  const [apiKey, baseUrl] = await Promise.all([
    getSecret(apiKeySecretName(provider)),
    getSecret(baseUrlSecretName(provider)),
  ])
  return {
    provider,
    hasApiKey: !!apiKey,
    hasBaseUrl: !!baseUrl,
    baseUrl: baseUrl ?? null,
  }
}

export async function listProviders(): Promise<ProviderConfig[]> {
  const out: ProviderConfig[] = []
  for (const p of SUPPORTED_PROVIDERS) out.push(await getProviderConfig(p))
  return out
}

export async function setProviderApiKey(provider: ProviderId, apiKey: string): Promise<void> {
  await putSecret(apiKeySecretName(provider), apiKey)
}

export async function setProviderBaseUrl(provider: ProviderId, baseUrl: string | null): Promise<void> {
  if (!baseUrl) {
    await deleteSecretRow(baseUrlSecretName(provider))
    return
  }
  await putSecret(baseUrlSecretName(provider), baseUrl)
}

export async function deleteProvider(provider: ProviderId): Promise<void> {
  await deleteSecretRow(apiKeySecretName(provider))
  await deleteSecretRow(baseUrlSecretName(provider))
}

/**
 * Build the env var map injected into `opencode serve`. Only configured
 * providers are included. Loopback base URLs are rewritten so sandbox
 * containers can reach the operator's host.
 */
export async function buildProviderEnv(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const provider of SUPPORTED_PROVIDERS) {
    const cfg = await getProviderConfig(provider)
    if (!cfg.hasApiKey) continue
    const apiKey = await getSecret(apiKeySecretName(provider))
    if (!apiKey) continue
    if (provider === 'anthropic') {
      out.ANTHROPIC_API_KEY = apiKey
      if (cfg.baseUrl) out.ANTHROPIC_BASE_URL = rewriteLoopbackForSandbox(cfg.baseUrl)
    } else if (provider === 'openai') {
      out.OPENAI_API_KEY = apiKey
      if (cfg.baseUrl) out.OPENAI_BASE_URL = rewriteLoopbackForSandbox(normalizeOpenAIBaseUrl(cfg.baseUrl))
    }
  }
  return out
}

/**
 * Identity-surface version: returns raw base URLs without loopback rewrite.
 * Env servers apply their own rewrite based on their `CC_KIND` (container
 * vs local), since "is localhost reachable" depends on where opencode
 * actually runs.
 */
export async function buildProviderEnvRaw(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const provider of SUPPORTED_PROVIDERS) {
    const cfg = await getProviderConfig(provider)
    if (!cfg.hasApiKey) continue
    const apiKey = await getSecret(apiKeySecretName(provider))
    if (!apiKey) continue
    if (provider === 'anthropic') {
      out.ANTHROPIC_API_KEY = apiKey
      if (cfg.baseUrl) out.ANTHROPIC_BASE_URL = cfg.baseUrl
    } else if (provider === 'openai') {
      out.OPENAI_API_KEY = apiKey
      if (cfg.baseUrl) out.OPENAI_BASE_URL = normalizeOpenAIBaseUrl(cfg.baseUrl)
    }
  }
  return out
}

export async function anyProviderConfigured(): Promise<boolean> {
  for (const p of SUPPORTED_PROVIDERS) {
    const cfg = await getProviderConfig(p)
    if (cfg.hasApiKey) return true
  }
  return false
}
