import { request as undiciRequest } from 'undici'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { readSecrets } from '../envmeta/service.js'
import {
  getIdentityToken as getStoredToken,
  setIdentityToken as setStoredToken,
} from './token.js'

/**
 * Minimal tRPC-over-HTTP client for the identity service's `envApi.*`
 * surface. Rather than pull in `@trpc/client` + typed `AppRouter` (which
 * would cross the package boundary), we hand-roll the same wire format the
 * fastify-tRPC adapter uses, the same way the opencode-plugin does.
 *
 *   - Query:    GET /trpc/<proc>?input=<superjson-wrapped JSON>
 *   - Mutation: POST /trpc/<proc>  body=<superjson-wrapped JSON>
 *
 * Requests carry `Authorization: Bearer <identityToken>` so the identity
 * server's `identityProcedure` middleware can resolve them.
 */

export class IdentityAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityAuthError'
  }
}

export class IdentityUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IdentityUnreachableError'
  }
}

export interface RepoConfigSummary {
  id: string
  name: string
  source?: 'github' | 'url'
  originUrl?: string
  ref?: string | null
  githubFullName: string | null
  [k: string]: unknown
}

export interface RepoConfigBundle {
  summary: RepoConfigSummary
  files: Array<{ path: string; contents: string }>
}

// Superjson wire format matches what the plugin client uses: `{ json: <val> }`.
// We don't use any special Date/Map/Set values on this surface, so the
// identity shape round-trips cleanly.
function sjEncode(value: unknown): unknown {
  return { json: value }
}

function sjDecode(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'json' in (payload as Record<string, unknown>)) {
    return (payload as { json: unknown }).json
  }
  return payload
}

/**
 * Live identity token storage lives in `./token` so the remote-log
 * transport can read it without importing this module (avoiding a cycle
 * through the logger). Re-export the read/write API here for callers that
 * already import the identity client.
 */
export async function initIdentityToken(): Promise<void> {
  const secrets = await readSecrets()
  if (secrets.identityToken) {
    setStoredToken(secrets.identityToken)
    logger.info('identity token loaded from secrets.json')
  } else {
    logger.warn('no identityToken in secrets.json; identity calls will fail')
  }
}

export const setIdentityToken = setStoredToken
export const getIdentityToken = getStoredToken

function url(procedure: string): string {
  const base = config.CC_IDENTITY_URL.replace(/\/+$/, '')
  return `${base}/trpc/${procedure}`
}

function headers(): Record<string, string> {
  const tok = getStoredToken()
  if (!tok) throw new IdentityAuthError('identity token not configured')
  return {
    authorization: `Bearer ${tok}`,
    'content-type': 'application/json',
  }
}

async function query<T>(procedure: string, input: Record<string, unknown> = {}): Promise<T> {
  try {
    const qp = `?input=${encodeURIComponent(JSON.stringify(sjEncode(input)))}`
    const res = await undiciRequest(url(procedure) + qp, {
      method: 'GET',
      headers: headers(),
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    })
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new IdentityAuthError(`identity auth rejected: ${res.statusCode}`)
    }
    const body = (await res.body.json()) as {
      result?: { data?: unknown }
      error?: { message?: string }
    }
    if (res.statusCode >= 400) {
      throw new IdentityUnreachableError(
        `identity ${procedure} http ${res.statusCode}: ${body.error?.message ?? ''}`,
      )
    }
    if (body.error) {
      throw new IdentityUnreachableError(`identity ${procedure} error: ${body.error.message}`)
    }
    return sjDecode(body.result?.data) as T
  } catch (err) {
    if (err instanceof IdentityAuthError || err instanceof IdentityUnreachableError) throw err
    throw new IdentityUnreachableError(
      `identity ${procedure} failed: ${(err as Error).message}`,
    )
  }
}

/** Fetches the provider env map (ANTHROPIC_API_KEY, etc.) from identity. */
export async function resolveProviderKeys(): Promise<Record<string, string>> {
  return query<Record<string, string>>('envApi.resolveProviderKeys')
}

export async function listRepoConfigs(): Promise<RepoConfigSummary[]> {
  return query<RepoConfigSummary[]>('envApi.listRepoConfigs')
}

export async function getRepoConfig(configId: string): Promise<RepoConfigBundle> {
  return query<RepoConfigBundle>('envApi.getRepoConfig', { configId })
}
