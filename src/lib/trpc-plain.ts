export function trpcQueryKey(path: string, input?: unknown) {
  const splitPath = path.split('.')
  if (typeof input === 'undefined') return [splitPath]
  return [splitPath, { input }]
}

export async function appTrpcQuery<T>(path: string, input?: unknown): Promise<T> {
  const url = new URL(`/trpc/${path}`, window.location.origin)
  if (typeof input !== 'undefined') {
    url.searchParams.set('input', JSON.stringify({ json: input }))
  }
  const res = await fetch(url, { credentials: 'include' })
  return parseTrpcResponse<T>(path, res)
}

export async function appTrpcMutation<T>(path: string, input?: unknown): Promise<T> {
  const res = await fetch(`/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ json: input }),
  })
  return parseTrpcResponse<T>(path, res)
}

async function parseTrpcResponse<T>(path: string, res: Response): Promise<T> {
  const json = await res.json().catch(() => null) as {
    result?: { data?: { json?: T } }
    error?: { json?: { message?: string }; message?: string }
  } | null
  const error = json?.error?.json?.message ?? json?.error?.message
  if (!res.ok || error) throw new Error(error ?? `${path} failed with HTTP ${res.status}`)
  return json?.result?.data?.json as T
}
