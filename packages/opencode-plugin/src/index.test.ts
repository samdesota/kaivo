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

/** Encode an SSE stream that matches what fastify-tRPC actually sends. */
function sseStream(events: Array<Record<string, unknown> | null>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = [enc.encode('event: connected\ndata: {}\n\n')]
  for (const e of events) {
    if (e === null) continue
    chunks.push(enc.encode(`data: ${JSON.stringify({ json: e })}\n\n`))
  }
  chunks.push(enc.encode('event: return\ndata: \n\n'))
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

  it('registers every browser tool when credentials exist', () => {
    const hooks = buildHooks({ tokenOverride: 't', appUrlOverride: 'http://app:3000' })

    expect(Object.keys(hooks.tool!).filter((name) => name.startsWith('cloud_browser_')).sort()).toEqual([
      'cloud_browser_connect_tab',
      'cloud_browser_disconnect',
      'cloud_browser_execute_js',
      'cloud_browser_interact',
      'cloud_browser_list_tabs',
      'cloud_browser_open_and_connect',
      'cloud_browser_read_logs',
      'cloud_browser_screenshot',
      'cloud_browser_snapshot',
    ])
  })

  it('browser tools call expected procedures with opencodeSessionId', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      const parsed = init?.body
        ? JSON.parse(init.body as string)
        : JSON.parse(requestUrl.searchParams.get('input') ?? '{}')
      calls.push({ url: `${requestUrl.origin}${requestUrl.pathname}`, body: parsed.json })
      const procedure = requestUrl.pathname.split('/trpc/')[1]
      const payload = procedure?.endsWith('snapshot')
        ? { text: 'snapshot text', url: 'https://example.com', title: 'Example', interactiveCount: 0, durationMs: 1 }
          : procedure?.endsWith('screenshot')
            ? { format: 'jpeg', width: 10, height: 10, base64: 'abc', byteLength: 2 }
            : procedure?.endsWith('readLogs')
              ? { entries: [], truncated: false }
            : procedure?.endsWith('listTabs')
              ? []
            : procedure?.endsWith('disconnect')
              ? { ok: true }
              : { cdpId: 'cdp-1', browserTabId: 'tab-1' }
      return new Response(JSON.stringify({ result: { data: { json: payload } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const hooks = buildHooks({ tokenOverride: 't', appUrlOverride: 'http://app:3000', fetchImpl })
    const ctx = makeCtx('oc-browser')

    await hooks.tool!.cloud_browser_list_tabs!.execute({}, ctx as never)
    await hooks.tool!.cloud_browser_connect_tab!.execute({ browserTabId: 'tab-1' }, ctx as never)
    await hooks.tool!.cloud_browser_open_and_connect!.execute({ url: 'https://example.com' }, ctx as never)
    await hooks.tool!.cloud_browser_disconnect!.execute({ cdpId: 'cdp-1' }, ctx as never)
    await hooks.tool!.cloud_browser_snapshot!.execute({ cdpId: 'cdp-1' }, ctx as never)
    await hooks.tool!.cloud_browser_interact!.execute({ cdpId: 'cdp-1', action: { type: 'wait' } }, ctx as never)
    await hooks.tool!.cloud_browser_read_logs!.execute({ cdpId: 'cdp-1' }, ctx as never)
    await hooks.tool!.cloud_browser_screenshot!.execute({ cdpId: 'cdp-1' }, ctx as never)
    await hooks.tool!.cloud_browser_execute_js!.execute({ cdpId: 'cdp-1', expression: 'document.title' }, ctx as never)

    expect(calls.map((call) => call.url)).toEqual([
      'http://app:3000/trpc/agentBrowser.listTabs',
      'http://app:3000/trpc/agentBrowser.connectTab',
      'http://app:3000/trpc/agentBrowser.openAndConnect',
      'http://app:3000/trpc/agentBrowser.disconnect',
      'http://app:3000/trpc/agentBrowser.snapshot',
      'http://app:3000/trpc/agentBrowser.interact',
      'http://app:3000/trpc/agentBrowser.readLogs',
      'http://app:3000/trpc/agentBrowser.screenshot',
      'http://app:3000/trpc/agentBrowser.executeJs',
    ])
    expect(calls.every((call) => (call.body as { opencodeSessionId?: string }).opencodeSessionId === 'oc-browser')).toBe(true)
    expect(calls[5]?.body).toMatchObject({ cdpId: 'cdp-1', action: { type: 'wait' } })
  })

  it('browser snapshot omits empty optional filter strings', async () => {
    const calls: Array<{ body: unknown }> = []
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const requestUrl = new URL(String(url))
      const parsed = JSON.parse(requestUrl.searchParams.get('input') ?? '{}')
      calls.push({ body: parsed.json })
      return new Response(JSON.stringify({ result: { data: { json: { text: 'snapshot text' } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const hooks = buildHooks({ tokenOverride: 't', appUrlOverride: 'http://app:3000', fetchImpl })

    await hooks.tool!.cloud_browser_snapshot!.execute(
      { cdpId: 'cdp-1', filter: '', filterFlags: '', viewportOnly: true },
      makeCtx('oc-browser') as never,
    )

    expect(calls[0]?.body).toEqual({ cdpId: 'cdp-1', viewportOnly: true, opencodeSessionId: 'oc-browser' })
  })

  it('browser interact normalizes shorthand action shapes', async () => {
    const calls: Array<{ body: unknown }> = []
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const parsed = JSON.parse(init!.body as string)
      calls.push({ body: parsed.json })
      return new Response(JSON.stringify({ result: { data: { json: { ok: true } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const hooks = buildHooks({ tokenOverride: 't', appUrlOverride: 'http://app:3000', fetchImpl })

    await hooks.tool!.cloud_browser_interact!.execute(
      { cdpId: 'cdp-1', action: { type: 'click', id: 28 }, postSnapshot: { filter: '', viewportOnly: true } },
      makeCtx('oc-browser') as never,
    )
    await hooks.tool!.cloud_browser_interact!.execute(
      { cdpId: 'cdp-1', action: { type: 'fill', id: 28, value: 'OpenAI' } },
      makeCtx('oc-browser') as never,
    )

    expect(calls[0]?.body).toMatchObject({
      cdpId: 'cdp-1',
      opencodeSessionId: 'oc-browser',
      action: { type: 'click', elementId: '28' },
      postSnapshot: { viewportOnly: true },
    })
    expect(calls[1]?.body).toMatchObject({
      cdpId: 'cdp-1',
      opencodeSessionId: 'oc-browser',
      action: { type: 'fill', fields: [{ elementId: '28', text: 'OpenAI' }] },
    })
  })

  it('browser tools map app errors to structured metadata', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const hooks = buildHooks({ tokenOverride: 't', appUrlOverride: 'http://nope', fetchImpl, backoffMs: [1] })

    const result = (await hooks.tool!.cloud_browser_snapshot!.execute(
      { cdpId: 'cdp-1' },
      makeCtx() as never,
    )) as { output: string; metadata: Record<string, unknown> }

    expect(result.output).toBe('')
    expect(result.metadata.status).toBe('error')
    expect(result.metadata.stderr).toBe('cloud-code app unreachable')
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

  it('cloud_pty_list: queries shells for the current opencode session', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe('GET')
      const requestUrl = new URL(String(url))
      expect(`${requestUrl.origin}${requestUrl.pathname}`).toBe('http://app:3000/trpc/agentShell.list')
      const parsed = JSON.parse(requestUrl.searchParams.get('input') ?? '{}')
      expect(parsed.json).toEqual({ opencodeSessionId: 'oc-list' })
      return new Response(
        JSON.stringify({
          result: {
            data: {
              json: [
                {
                  id: 'pty-42',
                  workspaceId: 'workspace-a',
                  cwd: '/tmp/project',
                  ownerKind: 'agent',
                  ownerAgentSessionId: null,
                  ownerSessionId: 'oc-list',
                  exitCode: null,
                  createdAt: '2026-05-09T00:00:00.000Z',
                  lastActivityAt: '2026-05-09T00:01:00.000Z',
                  alive: true,
                  title: 'npm run dev',
                },
              ],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const hooks = buildHooks({ tokenOverride: 't', appUrlOverride: 'http://app:3000', fetchImpl })
    const result = (await hooks.tool!.cloud_pty_list!.execute(
      {},
      makeCtx('oc-list') as never,
    )) as { output: string; metadata: Record<string, unknown> }

    expect(result.output).toContain('pty-42 alive cwd="/tmp/project"')
    expect(result.output).toContain('title="npm run dev"')
    expect(result.metadata.count).toBe(1)
    expect(result.metadata.shell_ids).toEqual(['pty-42'])
  })

  it('cloud_open_pane: mutation publishes pane intent', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://app:3000/trpc/agentUi.openPane')
      expect(init?.method).toBe('POST')
      const parsed = JSON.parse(init!.body as string)
      expect(parsed.json).toEqual({
        opencodeSessionId: 'oc-pane',
        content: { type: 'file', path: '/src/app.ts' },
        title: 'app.ts',
        activate: true,
      })
      return new Response(JSON.stringify({ result: { data: { json: { ok: true } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const hooks = buildHooks({
      tokenOverride: 't',
      appUrlOverride: 'http://app:3000',
      fetchImpl,
    })
    const result = (await hooks.tool!.cloud_open_pane!.execute(
      { kind: 'file', path: '/src/app.ts', title: 'app.ts', activate: true },
      makeCtx('oc-pane') as never,
    )) as { output: string; metadata: Record<string, unknown> }

    expect(result.output).toBe('Opened file pane /src/app.ts.')
    expect(result.metadata.status).toBe('success')
    expect(result.metadata.pane_type).toBe('file')
  })

  it('cloud_open_pane: browser mutation publishes pane intent', async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('http://app:3000/trpc/agentUi.openPane')
      expect(init?.method).toBe('POST')
      const parsed = JSON.parse(init!.body as string)
      expect(parsed.json).toEqual({
        opencodeSessionId: 'oc-browser-pane',
        content: { type: 'browser', url: 'https://example.com' },
        title: 'Example',
        activate: true,
      })
      return new Response(JSON.stringify({ result: { data: { json: { ok: true } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const hooks = buildHooks({
      tokenOverride: 't',
      appUrlOverride: 'http://app:3000',
      fetchImpl,
    })
    const result = (await hooks.tool!.cloud_open_pane!.execute(
      { kind: 'browser', url: 'https://example.com', title: 'Example', activate: true },
      makeCtx('oc-browser-pane') as never,
    )) as { output: string; metadata: Record<string, unknown> }

    expect(result.output).toBe('Opened browser pane https://example.com.')
    expect(result.metadata.status).toBe('success')
    expect(result.metadata.pane_type).toBe('browser')
  })

  it('cloud_open_pane: omits empty title', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const parsed = JSON.parse(init!.body as string)
      expect(parsed.json).toEqual({
        opencodeSessionId: 'oc-empty-title',
        content: { type: 'file', path: 'src/app.ts' },
        activate: undefined,
      })
      return new Response(JSON.stringify({ result: { data: { json: { ok: true } } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const hooks = buildHooks({
      tokenOverride: 't',
      appUrlOverride: 'http://app:3000',
      fetchImpl,
    })
    await hooks.tool!.cloud_open_pane!.execute(
      { kind: 'file', path: 'src/app.ts', title: '' },
      makeCtx('oc-empty-title') as never,
    )
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
