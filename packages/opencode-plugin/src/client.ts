/**
 * Tiny tRPC-over-HTTP client for the cloud-code app's agentShell router.
 *
 * Avoids pulling in @trpc/client so the plugin bundle stays small. Talks to
 * the fastify-tRPC adapter's URL scheme:
 *
 *   - Query:        GET  /trpc/<proc>?input=<json>
 *   - Mutation:     POST /trpc/<proc>  body=<json>
 *   - Subscription: GET  /trpc/<proc>?input=<json>  Accept: text/event-stream
 *
 * Requests carry `Authorization: Bearer <CLOUDCODE_AGENT_TOKEN>`. Both the
 * input and the response are wrapped by superjson on the server; we send
 * superjson-wrapped payloads and unwrap responses through a tiny subset.
 */

/** Minimal superjson encoder/decoder: handles string/number/boolean/null/array/object (no Date/Map/Set). */
function sjEncode(value: unknown): unknown {
  return { json: value }
}

function sjDecode(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'json' in (payload as Record<string, unknown>)) {
    return (payload as { json: unknown }).json
  }
  return payload
}

export interface AgentShellClientOpts {
  appUrl: string
  token: string
  fetchImpl?: typeof fetch
  backoffMs?: number[]
  /** Log hook for structured messages. Default: console.log. */
  log?: (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) => void
}

const DEFAULT_BACKOFF_MS = [250, 1_000, 2_500, 5_000]

export class AppUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppUnreachableError'
  }
}

export interface RunOnceEvent {
  type: 'started' | 'stdout' | 'stderr' | 'exit'
  shellId?: string
  b64?: string
  code?: number
  truncated?: boolean
}

export class AgentShellClient {
  private readonly appUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly backoff: number[]
  private readonly log: NonNullable<AgentShellClientOpts['log']>

  constructor(opts: AgentShellClientOpts) {
    // Normalise to no trailing slash.
    this.appUrl = opts.appUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS
    this.log =
      opts.log ?? ((level, msg, data) => console[level === 'info' ? 'log' : level](msg, data ?? {}))
  }

  private url(procedure: string): string {
    return `${this.appUrl}/trpc/${procedure}`
  }

  private headers(accept?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    }
    if (accept) h.Accept = accept
    return h
  }

  private async withBackoff<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown = null
    for (let i = 0; i <= this.backoff.length; i++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        if (i === this.backoff.length) break
        const delay = this.backoff[i]!
        this.log('warn', `${label} failed, retrying in ${delay}ms`, { err: (err as Error).message })
        await new Promise((r) => setTimeout(r, delay))
      }
    }
    throw new AppUnreachableError(
      `cloud-code app unreachable: ${(lastErr as Error | null)?.message ?? 'unknown error'}`,
    )
  }

  /** POST mutation; throws AppUnreachableError after backoff exhausted. */
  async mutate<T>(procedure: string, input: Record<string, unknown>): Promise<T> {
    return this.withBackoff(procedure, async () => {
      const res = await this.fetchImpl(this.url(procedure), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(sjEncode(input)),
      })
      if (res.status === 401 || res.status === 403) {
        throw new Error(`auth rejected: ${res.status}`)
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`http ${res.status}: ${body.slice(0, 200)}`)
      }
      const json = (await res.json()) as { result?: { data?: unknown }; error?: { message?: string } }
      if (json.error) throw new Error(json.error.message ?? 'trpc error')
      return sjDecode(json.result?.data) as T
    })
  }

  /** GET query; throws AppUnreachableError after backoff exhausted. */
  async query<T>(procedure: string, input: Record<string, unknown>): Promise<T> {
    return this.withBackoff(procedure, async () => {
      const qp = new URLSearchParams({ input: JSON.stringify(sjEncode(input)) })
      const res = await this.fetchImpl(`${this.url(procedure)}?${qp.toString()}`, {
        method: 'GET',
        headers: this.headers(),
      })
      if (res.status === 401 || res.status === 403) {
        throw new Error(`auth rejected: ${res.status}`)
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`http ${res.status}: ${body.slice(0, 200)}`)
      }
      const json = (await res.json()) as { result?: { data?: unknown }; error?: { message?: string } }
      if (json.error) throw new Error(json.error.message ?? 'trpc error')
      return sjDecode(json.result?.data) as T
    })
  }

  /**
   * Open an SSE subscription. Yields parsed event data until the stream
   * closes. `abort` signal aborts the request. Establishes the connection
   * through the same backoff wrapper as queries — once the stream is
   * flowing, downstream errors surface as thrown exceptions.
   */
  async *subscribe(
    procedure: string,
    input: Record<string, unknown>,
    abort?: AbortSignal,
  ): AsyncGenerator<RunOnceEvent, void, void> {
    const qp = new URLSearchParams({ input: JSON.stringify(sjEncode(input)) })
    const res = await this.withBackoff(procedure, async () => {
      const r = await this.fetchImpl(`${this.url(procedure)}?${qp.toString()}`, {
        method: 'GET',
        headers: this.headers('text/event-stream'),
        signal: abort,
      })
      if (r.status === 401 || r.status === 403) {
        throw new Error(`auth rejected: ${r.status}`)
      }
      if (!r.ok || !r.body) {
        const body = await (r.text().catch(() => '') as Promise<string>)
        throw new Error(`http ${r.status}: ${body.slice(0, 200)}`)
      }
      return r
    })

    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) return
        buf += decoder.decode(value, { stream: true })
        // SSE events are separated by "\n\n".
        let sep = buf.indexOf('\n\n')
        while (sep >= 0) {
          const frame = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          const evt = parseSseFrame(frame)
          if (evt) yield evt
          sep = buf.indexOf('\n\n')
        }
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        // ignore
      }
    }
  }
}

function parseSseFrame(frame: string): RunOnceEvent | null {
  const lines = frame.split('\n')
  let data = ''
  for (const l of lines) {
    if (l.startsWith('data:')) data += l.slice(5).trim()
  }
  if (!data || data === '[DONE]') return null
  try {
    const parsed = JSON.parse(data) as {
      result?: { type?: string; data?: unknown }
      error?: { message?: string }
    }
    if (parsed.error) throw new Error(parsed.error.message ?? 'sse trpc error')
    // httpSubscriptionLink wraps payloads in { result: { type: 'data', data: ... } }.
    const payload = parsed.result?.data
    const decoded = sjDecode(payload) as RunOnceEvent | undefined
    return decoded ?? null
  } catch (err) {
    void err
    return null
  }
}
