import {
  createTRPCClient,
  createWSClient,
  httpBatchLink,
  splitLink,
  wsLink,
} from '@trpc/client'
import superjson from 'superjson'

/**
 * Webapp-facing view of a cc-env endpoint. Container envs store a
 * relative URL (`/env/<id>`) that the orchestrator's reverse proxy
 * resolves; local envs store an absolute `http://127.0.0.1:47821`.
 */
export interface EnvRef {
  id: string
  kind: 'container' | 'local'
  url: string
}

/** Resolve an env's stored URL to an absolute origin-based URL. */
export function resolveEnvUrl(env: EnvRef): string {
  if (env.url.startsWith('http://') || env.url.startsWith('https://')) {
    return env.url.replace(/\/+$/, '')
  }
  const origin = window.location.origin.replace(/\/+$/, '')
  const path = env.url.startsWith('/') ? env.url : '/' + env.url
  return `${origin}${path}`
}

/** Build the WS origin for an env (ws/wss). */
export function envWsUrl(env: EnvRef, path: string): string {
  const abs = resolveEnvUrl(env)
  const u = new URL(abs, window.location.origin)
  const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:'
  const p = path.startsWith('/') ? path : '/' + path
  return `${wsProto}//${u.host}${u.pathname.replace(/\/+$/, '')}${p}`
}

/**
 * Build a bearer-authenticated tRPC client pointed at an env-server.
 * HTTP goes through the env's `/trpc` endpoint; subscriptions use a
 * WS link. Each call carries `Authorization: Bearer <envToken>`.
 *
 * The returned client is loosely typed (`createTRPCClient<never>`'s
 * structural shape) — callers should go through the helpers below,
 * or cast to an env-server `AppRouter` if they want full typing.
 */
export function makeEnvClient(env: EnvRef, envToken: string) {
  const base = resolveEnvUrl(env)
  const ws = createWSClient({
    url: envWsUrl(env, '/trpc'),
    connectionParams: { token: envToken },
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createTRPCClient<any>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: wsLink({ client: ws, transformer: superjson }),
        false: httpBatchLink({
          url: `${base}/trpc`,
          transformer: superjson,
          async headers() {
            return { authorization: `Bearer ${envToken}` }
          },
          fetch(url, options) {
            // Env tokens are bearer tokens, not cookies — don't send
            // credentials so the browser doesn't attach stale admin
            // cookies to cross-origin env requests.
            return fetch(url, { ...options, credentials: 'omit' })
          },
        }),
      }),
    ],
  })
}

/**
 * Fire a pair.start → pair.confirm round-trip against an *unpaired*
 * env server. No envToken yet at this point; these are the only
 * procedures exposed on an unpaired env.
 */
export async function startPairing(
  envUrl: string,
): Promise<{ sessionId: string; expiresIn: number }> {
  const base = envUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/trpc/pair.start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'omit',
    body: '{}',
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`pair.start http ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as {
    result?: { data?: { json?: { sessionId: string; expiresIn: number } } }
    error?: { message?: string }
  }
  if (json.error) throw new Error(json.error.message ?? 'pair.start failed')
  const data = json.result?.data?.json
  if (!data) throw new Error('pair.start returned no data')
  return data
}

export async function confirmPairing(
  envUrl: string,
  sessionId: string,
  code: string,
): Promise<{ envToken: string }> {
  const base = envUrl.replace(/\/+$/, '')
  const res = await fetch(`${base}/trpc/pair.confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({ json: { sessionId, code } }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`pair.confirm http ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = (await res.json()) as {
    result?: { data?: { json?: { envToken: string } } }
    error?: { message?: string }
  }
  if (json.error) throw new Error(json.error.message ?? 'pair.confirm failed')
  const data = json.result?.data?.json
  if (!data?.envToken) throw new Error('pair.confirm returned no token')
  return data
}
