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
  const mocked = maybeMockTrpcMutation<T>(path, input)
  if (mocked) return mocked
  const res = await fetch(`/trpc/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ json: input }),
  })
  return parseTrpcResponse<T>(path, res)
}

function maybeMockTrpcMutation<T>(path: string, input?: unknown): Promise<T> | null {
  const dev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV
  if (!dev || typeof window === 'undefined') return null
  if (window.localStorage.getItem('__kaivo_mock_bookmark_mutations') !== 'true') return null
  if (path !== 'bookmarks.upsert') return null
  const calls = JSON.parse(window.localStorage.getItem('__kaivo_mock_bookmark_mutation_calls') || '[]') as unknown[]
  calls.push(input)
  window.localStorage.setItem('__kaivo_mock_bookmark_mutation_calls', JSON.stringify(calls))
  const bookmark = input as { title?: string; url?: string; faviconDataUrl?: string | null; faviconUrl?: string | null }
  return Promise.resolve({
    id: 'bookmark-e2e',
    title: bookmark.title ?? 'Bookmark',
    url: bookmark.url ?? 'https://example.com',
    normalizedUrl: bookmark.url ?? 'https://example.com',
    origin: 'https://example.com',
    faviconDataUrl: bookmark.faviconDataUrl ?? null,
    faviconUrl: bookmark.faviconUrl ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as T)
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
