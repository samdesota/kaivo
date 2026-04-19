import { describe, expect, it, vi } from 'vitest'
import { buildHooks } from './index.js'

/**
 * Unit tests for the OpenCode plugin. We don't need a real OpenCode runtime
 * here — we pull `hooks.tool.cloud_bash.execute` out and invoke it directly
 * with a stubbed fetch so we can verify the app-facing HTTP shape, SSE
 * parsing, and error fallbacks.
 */

interface FakeToolCtx {
  sessionID: string
  metadata: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  abort: AbortSignal
  metadataCalls: Array<{ title?: string; metadata?: Record<string, unknown> }>
}

function makeCtx(sessionID = 'oc-sess-1'): FakeToolCtx {
  const calls: FakeToolCtx['metadataCalls'] = []
  return {
    sessionID,
    metadata: (i) => {
      calls.push(i)
    },
    abort: new AbortController().signal,
    metadataCalls: calls,
  }
}

/** Encode an SSE stream from a list of tRPC event payloads. */
function sseStream(events: Array<Record<string, unknown> | null>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  for (const e of events) {
    if (e === null) chunks.push(enc.encode('data: [DONE]\n\n'))
    else
      chunks.push(
        enc.encode(
          `data: ${JSON.stringify({ result: { type: 'data', data: { json: e } } })}\n\n`,
        ),
      )
  }
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
}

describe('cloud-code opencode plugin', () => {
  it('returns no tools when env vars are missing', async () => {
    const hooks = buildHooks({})
    expect(hooks.tool).toBeUndefined()
  })

  it('cloud_bash: SSE drives run-once; returns stdout + metadata', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-xyz')
      expect((init?.headers as Record<string, string>).Accept).toBe('text/event-stream')
      return new Response(
        sseStream([
          { type: 'started', shellId: 'sh-abc' },
          { type: 'stdout', b64: Buffer.from('hello\n').toString('base64') },
          { type: 'stderr', b64: Buffer.from('warn\n').toString('base64') },
          { type: 'exit', code: 0, truncated: false },
        ]),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof fetch

    const hooks = buildHooks({
      tokenOverride: 'tok-xyz',
      appUrlOverride: 'http://app:3000',
      fetchImpl,
    })
    const ctx = makeCtx()
    const cloudBash = hooks.tool!.cloud_bash!
    const result = (await cloudBash.execute(
      { command: 'echo hello' },
      ctx as never,
    )) as { output: string; metadata: Record<string, unknown> }

    expect(result.output).toBe('hello\nwarn\n')
    expect(result.metadata.cloudcode_shell_id).toBe('sh-abc')
    expect(result.metadata.exit_code).toBe(0)
    // metadata() should have been called at least twice: once on 'started'
    // (running), once at completion (success).
    expect(ctx.metadataCalls.length).toBeGreaterThanOrEqual(2)
    const running = ctx.metadataCalls.find((m) => m.metadata?.status === 'running')
    const success = ctx.metadataCalls.find((m) => m.metadata?.status === 'success')
    expect(running?.metadata?.cloudcode_shell_id).toBe('sh-abc')
    expect(success?.metadata?.exit_code).toBe(0)
  })

  it('cloud_bash: returns structured error if app is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const hooks = buildHooks({
      tokenOverride: 't',
      appUrlOverride: 'http://unreachable',
      fetchImpl,
      backoffMs: [1, 1], // keep the test fast
    })
    const cloudBash = hooks.tool!.cloud_bash!
    const result = (await cloudBash.execute(
      { command: 'ls' },
      makeCtx() as never,
    )) as { output: string; metadata: Record<string, unknown> }
    expect(result.metadata.status).toBe('error')
    expect(result.metadata.stderr).toBe('cloud-code app unreachable')
    expect(result.metadata.exit_code).toBe(1)
  })

  it('cloud_pty: mutation returns shellId; metadata emits it', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      const parsed = JSON.parse(init!.body as string)
      expect(parsed.json.opencodeSessionId).toBe('oc-xyz')
      return new Response(
        JSON.stringify({ result: { data: { json: { shellId: 'pty-42' } } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const hooks = buildHooks({
      tokenOverride: 't',
      appUrlOverride: 'http://app:3000',
      fetchImpl,
    })
    const ctx = makeCtx('oc-xyz')
    const cloudPty = hooks.tool!.cloud_pty!
    const result = (await cloudPty.execute(
      { cwd: '/tmp' },
      ctx as never,
    )) as { output: string; metadata: Record<string, unknown> }
    expect(result.metadata.cloudcode_shell_id).toBe('pty-42')
    expect(ctx.metadataCalls.at(0)?.metadata?.cloudcode_shell_id).toBe('pty-42')
  })

  it('cloud_pty: structured error on unreachable app', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const hooks = buildHooks({
      tokenOverride: 't',
      appUrlOverride: 'http://nope',
      fetchImpl,
      backoffMs: [1, 1],
    })
    const result = (await hooks.tool!.cloud_pty!.execute(
      {},
      makeCtx() as never,
    )) as { output: string; metadata: Record<string, unknown> }
    expect(result.metadata.status).toBe('error')
    expect(result.metadata.stderr).toBe('cloud-code app unreachable')
  })

  it('cloud_bash: tolerates 401 auth rejection without infinite retry', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch
    const hooks = buildHooks({
      tokenOverride: 'bad',
      appUrlOverride: 'http://app:3000',
      fetchImpl,
      backoffMs: [],
    })
    const result = (await hooks.tool!.cloud_bash!.execute(
      { command: 'x' },
      makeCtx() as never,
    )) as { output: string; metadata: Record<string, unknown> }
    expect(result.metadata.status).toBe('error')
    // The exact message goes through backoff wrapper → "cloud-code app unreachable".
    expect(typeof result.metadata.stderr).toBe('string')
  })
})
