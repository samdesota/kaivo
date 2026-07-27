import { describe, expect, it, vi } from 'vitest'
import { buildHooks } from './index.js'

/**
 * Unit tests for the OpenCode plugin. We don't need a real OpenCode runtime
 * here — we pull `hooks.tool.kaivo_bash.execute` out and invoke it directly
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

describe('Kaivo opencode plugin', () => {
  it('returns no tools when env vars are missing', async () => {
    const hooks = buildHooks({})
    expect(hooks.tool).toBeUndefined()
  })

  it('kaivo_bash: SSE drives run-once; returns stdout + metadata', async () => {
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
    const cloudBash = hooks.tool!.kaivo_bash!
    const result = (await cloudBash.execute(
      { command: 'echo hello' },
      ctx as never,
    )) as { output: string; metadata: Record<string, unknown> }

    expect(result.output).toBe('hello\nwarn\n')
    expect(result.metadata.kaivo_shell_id).toBe('sh-abc')
    expect(result.metadata.exit_code).toBe(0)
    // metadata() should have been called at least twice: once on 'started'
    // (running), once at completion (success).
    expect(ctx.metadataCalls.length).toBeGreaterThanOrEqual(2)
    const running = ctx.metadataCalls.find((m) => m.metadata?.status === 'running')
    const success = ctx.metadataCalls.find((m) => m.metadata?.status === 'success')
    expect(running?.metadata?.kaivo_shell_id).toBe('sh-abc')
    expect(success?.metadata?.exit_code).toBe(0)
  })

  it('registers every browser tool when credentials exist', () => {
    const hooks = buildHooks({ tokenOverride: 't', appUrlOverride: 'http://app:3000' })

    expect(Object.keys(hooks.tool!).filter((name) => name.startsWith('kaivo_browser_')).sort()).toEqual([
      'kaivo_browser_connect_tab',
      'kaivo_browser_disconnect',
      'kaivo_browser_execute_js',
      'kaivo_browser_interact',
      'kaivo_browser_list_tabs',
      'kaivo_browser_open_and_connect',
      'kaivo_browser_read_logs',
      'kaivo_browser_screenshot',
      'kaivo_browser_snapshot',
    ])
  })

  it('dispatch tool binds tool-context identity and preserves operation ids across transport retries', async () => {
    const calls: Array<{ procedure: string; body: Record<string, unknown>; authorization: string }> = []
    let dispatchAttempts = 0
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const requestUrl = new URL(String(url))
      const procedure = requestUrl.pathname.split('/trpc/')[1] ?? ''
      const body = (JSON.parse(String(init?.body)) as { json: Record<string, unknown> }).json
      const authorization = (init?.headers as Record<string, string>).Authorization ?? ''
      calls.push({ procedure, body, authorization })
      if (procedure === 'orchestration.bindAgentSession') {
        return new Response(JSON.stringify({ result: { data: { json: { token: 'session-token' } } } }), { status: 200 })
      }
      dispatchAttempts++
      if (dispatchAttempts === 1) throw new Error('connection reset')
      return new Response(JSON.stringify({
        result: { data: { json: { subtaskId: 'task-1', sessionId: 'session-1', state: 'active' } } },
      }), { status: 200 })
    }) as unknown as typeof fetch
    const hooks = buildHooks({ tokenOverride: 'process-token', appUrlOverride: 'http://app:3000', fetchImpl, backoffMs: [1] })

    const result = await hooks.tool!.kaivo_dispatch_subtask!.execute({
      operationId: 'stable-operation',
      title: 'Inspect parser',
      instruction: 'Review the parser.',
      sourceRef: 'refs/heads/main',
      branchName: 'task/parser',
      deliveryMode: 'pull_request',
    }, makeCtx('oc-dispatch') as never) as { metadata: Record<string, unknown> }

    expect(result.metadata).toMatchObject({ subtaskId: 'task-1', sessionId: 'session-1', status: 'active' })
    expect(calls[0]).toMatchObject({
      procedure: 'orchestration.bindAgentSession',
      body: { opencodeSessionId: 'oc-dispatch' },
      authorization: 'Bearer process-token',
    })
    const dispatchCalls = calls.filter((call) => call.procedure === 'orchestration.dispatchFromAgent')
    expect(dispatchCalls).toHaveLength(2)
    expect(dispatchCalls.every((call) => call.body.operationId === 'stable-operation')).toBe(true)
    expect(dispatchCalls.every((call) => !('repositoryId' in call.body))).toBe(true)
    expect(dispatchCalls.every((call) => call.authorization === 'Bearer session-token')).toBe(true)
    expect(dispatchCalls.every((call) => !('workspaceId' in call.body) && !('dispatchSessionId' in call.body))).toBe(true)
  })

  it.each(['provisioning', 'active', 'failed'] as const)('dispatch tool returns %s results', async (state) => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const procedure = new URL(String(url)).pathname.split('/trpc/')[1]
      const json = procedure === 'orchestration.bindAgentSession'
        ? { token: `token-${state}` }
        : { subtaskId: `task-${state}`, state, ...(state === 'failed' ? { failure: { message: 'clone failed' } } : {}) }
      return new Response(JSON.stringify({ result: { data: { json } } }), { status: 200 })
    }) as unknown as typeof fetch
    const hooks = buildHooks({ tokenOverride: 'process-token', appUrlOverride: 'http://app:3000', fetchImpl })
    const result = await hooks.tool!.kaivo_dispatch_subtask!.execute({
      operationId: `operation-${state}`,
      title: 'Task',
      instruction: 'Do it.',
      sourceRef: 'main',
      branchName: `task/${state}`,
      deliveryMode: 'dispatcher_integration',
    }, makeCtx(`oc-${state}`) as never) as { metadata: Record<string, unknown> }
    expect(result.metadata).toMatchObject({ subtaskId: `task-${state}`, status: state })
  })

  it('surfaces cancelled repository setup without retrying it as an outage', async () => {
    let dispatchCalls = 0
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const procedure = new URL(String(url)).pathname.split('/trpc/')[1]
      if (procedure === 'orchestration.bindAgentSession') {
        return new Response(JSON.stringify({ result: { data: { json: { token: 'session-token' } } } }), { status: 200 })
      }
      dispatchCalls++
      return new Response('repository setup was cancelled', { status: 400 })
    }) as unknown as typeof fetch
    const hooks = buildHooks({
      tokenOverride: 'process-token', appUrlOverride: 'http://app:3000', fetchImpl, backoffMs: [1, 1],
    })
    const result = await hooks.tool!.kaivo_dispatch_subtask!.execute({
      operationId: 'operation-cancelled', title: 'Task', instruction: 'Do it.', sourceRef: 'main',
      branchName: 'task/cancelled', deliveryMode: 'dispatcher_integration',
    }, makeCtx('oc-cancelled') as never) as { metadata: Record<string, unknown> }
    expect(result.metadata).toMatchObject({ status: 'error' })
    expect(result.metadata.stderr).toContain('repository setup was cancelled')
    expect(dispatchCalls).toBe(1)
  })

  it('reports delivery with subtask-bound identity and rejects non-subtask callers', async () => {
    const calls: Array<{ procedure: string; body: Record<string, unknown>; authorization: string }> = []
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const procedure = new URL(String(url)).pathname.split('/trpc/')[1] ?? ''
      const body = (JSON.parse(String(init?.body)) as { json: Record<string, unknown> }).json
      calls.push({ procedure, body, authorization: (init?.headers as Record<string, string>).Authorization ?? '' })
      const json = procedure === 'orchestration.bindAgentSession'
        ? { token: 'subtask-token', principal: { sessionKind: body.opencodeSessionId === 'oc-subtask' ? 'subtask' : 'dispatch' } }
        : { id: 'task-1', delivery: body }
      return new Response(JSON.stringify({ result: { data: { json } } }), { status: 200 })
    }) as unknown as typeof fetch
    const hooks = buildHooks({ tokenOverride: 'process-token', appUrlOverride: 'http://app:3000', fetchImpl })

    const result = await hooks.tool!.kaivo_report_subtask_delivery!.execute({
      pullRequestUrl: 'https://github.com/acme/repo/pull/42', headCommit: 'abc123', summary: 'Ready',
    }, makeCtx('oc-subtask') as never) as { metadata: Record<string, unknown> }
    expect(result.metadata.status).toBe('success')
    expect(calls[1]).toEqual({
      procedure: 'orchestration.reportDelivery',
      body: { pullRequestUrl: 'https://github.com/acme/repo/pull/42', headCommit: 'abc123', summary: 'Ready' },
      authorization: 'Bearer subtask-token',
    })
    const denied = await hooks.tool!.kaivo_report_subtask_delivery!.execute({ summary: 'No' }, makeCtx('oc-dispatch') as never) as { metadata: Record<string, unknown> }
    expect(denied.metadata).toMatchObject({ status: 'error', stderr: 'subtask agent session required' })
  })

  it('regenerates bounded dispatcher context on every hook without persisting stale state', async () => {
    const calls: Array<{ procedure: string; authorization: string }> = []
    let contextCall = 0
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const procedure = new URL(String(url)).pathname.split('/trpc/')[1] ?? ''
      calls.push({ procedure, authorization: (init?.headers as Record<string, string>).Authorization ?? '' })
      if (procedure === 'orchestration.bindAgentSession') {
        return new Response(JSON.stringify({ result: { data: { json: {
          token: 'bound-token', principal: { sessionKind: 'dispatch' },
        } } } }), { status: 200 })
      }
      contextCall++
      if (contextCall === 3) return new Response('failed', { status: 500 })
      return new Response(JSON.stringify({ result: { data: { json: { context: `snapshot-${contextCall}` } } } }), { status: 200 })
    }) as unknown as typeof fetch
    const hooks = buildHooks({ tokenOverride: 'process-token', appUrlOverride: 'http://app:3000', fetchImpl })
    const transform = hooks['experimental.chat.system.transform']!
    const first = { system: ['base system'] }
    await transform({ sessionID: 'oc-dispatch', model: {} as never }, first)
    expect(first.system).toEqual(['base system\n\nsnapshot-1'])
    const second = { system: ['base system'] }
    await transform({ sessionID: 'oc-dispatch', model: {} as never }, second)
    expect(second.system).toEqual(['base system\n\nsnapshot-2'])
    const failed = { system: ['base system'] }
    await expect(transform({ sessionID: 'oc-dispatch', model: {} as never }, failed)).resolves.toBeUndefined()
    expect(failed.system).toEqual(['base system'])
    expect(calls.filter((call) => call.procedure === 'orchestration.bindAgentSession')).toHaveLength(1)
    expect(calls.filter((call) => call.procedure === 'orchestration.dispatcherContext')).toHaveLength(3)
    expect(calls[0]?.authorization).toBe('Bearer process-token')
    expect(calls.slice(1).every((call) => call.authorization === 'Bearer bound-token')).toBe(true)
  })

  it('keeps a chat-bound credential usable after lazy dispatch initialization', async () => {
    const procedures: string[] = []
    let initialized = false
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const procedure = new URL(String(url)).pathname.split('/trpc/')[1] ?? ''
      procedures.push(procedure)
      const json = procedure === 'orchestration.bindAgentSession'
        ? { token: 'chat-token', principal: { sessionKind: 'chat' } }
        : procedure === 'orchestration.dispatchFromAgent'
          ? (initialized = true, { subtaskId: 'task-1', sessionId: 'task-session-1', state: 'active' })
          : { context: initialized ? '<kaivo-orchestration-status>active</kaivo-orchestration-status>' : '' }
      return new Response(JSON.stringify({ result: { data: { json } } }), { status: 200 })
    }) as unknown as typeof fetch
    const hooks = buildHooks({ tokenOverride: 'process-token', appUrlOverride: 'http://app:3000', fetchImpl })
    const transform = hooks['experimental.chat.system.transform']!

    const before = { system: ['base'] }
    await transform({ sessionID: 'oc-chat', model: {} as never }, before)
    expect(before.system).toEqual(['base'])
    await hooks.tool!.kaivo_dispatch_subtask!.execute({
      operationId: 'lazy-1', title: 'Task', instruction: 'Do it', sourceRef: 'main', branchName: 'task/lazy', deliveryMode: 'dispatcher_integration',
    }, makeCtx('oc-chat') as never)
    const after = { system: ['base'] }
    await transform({ sessionID: 'oc-chat', model: {} as never }, after)
    expect(after.system[0]).toContain('<kaivo-orchestration-status>active')
    expect(procedures.filter((procedure) => procedure === 'orchestration.bindAgentSession')).toHaveLength(1)
  })

  it('leaves system context unchanged for missing or subtask sessions', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: { data: { json: {
      token: 'bound-token', principal: { sessionKind: 'subtask' },
    } } } }), { status: 200 })) as unknown as typeof fetch
    const hooks = buildHooks({ tokenOverride: 'process-token', appUrlOverride: 'http://app:3000', fetchImpl })
    const transform = hooks['experimental.chat.system.transform']!
    const missing = { system: ['base'] }
    await transform({ model: {} as never }, missing)
    const subtask = { system: ['base'] }
    await transform({ sessionID: 'oc-subtask', model: {} as never }, subtask)
    expect(missing.system).toEqual(['base'])
    expect(subtask.system).toEqual(['base'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
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

    await hooks.tool!.kaivo_browser_list_tabs!.execute({}, ctx as never)
    await hooks.tool!.kaivo_browser_connect_tab!.execute({ browserTabId: 'tab-1' }, ctx as never)
    await hooks.tool!.kaivo_browser_open_and_connect!.execute({ url: 'https://example.com' }, ctx as never)
    await hooks.tool!.kaivo_browser_disconnect!.execute({ cdpId: 'cdp-1' }, ctx as never)
    await hooks.tool!.kaivo_browser_snapshot!.execute({ cdpId: 'cdp-1' }, ctx as never)
    await hooks.tool!.kaivo_browser_interact!.execute({ cdpId: 'cdp-1', action: { type: 'wait' } }, ctx as never)
    await hooks.tool!.kaivo_browser_read_logs!.execute({ cdpId: 'cdp-1' }, ctx as never)
    await hooks.tool!.kaivo_browser_screenshot!.execute({ cdpId: 'cdp-1' }, ctx as never)
    await hooks.tool!.kaivo_browser_execute_js!.execute({ cdpId: 'cdp-1', expression: 'document.title' }, ctx as never)

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

    await hooks.tool!.kaivo_browser_snapshot!.execute(
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

    await hooks.tool!.kaivo_browser_interact!.execute(
      { cdpId: 'cdp-1', action: { type: 'click', id: 28 }, postSnapshot: { filter: '', viewportOnly: true } },
      makeCtx('oc-browser') as never,
    )
    await hooks.tool!.kaivo_browser_interact!.execute(
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

    const result = (await hooks.tool!.kaivo_browser_snapshot!.execute(
      { cdpId: 'cdp-1' },
      makeCtx() as never,
    )) as { output: string; metadata: Record<string, unknown> }

    expect(result.output).toBe('')
    expect(result.metadata.status).toBe('error')
    expect(result.metadata.stderr).toBe('Kaivo app unreachable')
  })

  it('kaivo_bash: returns structured error if app is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const hooks = buildHooks({
      tokenOverride: 't',
      appUrlOverride: 'http://unreachable',
      fetchImpl,
      backoffMs: [1, 1], // keep the test fast
    })
    const cloudBash = hooks.tool!.kaivo_bash!
    const result = (await cloudBash.execute(
      { command: 'ls' },
      makeCtx() as never,
    )) as { output: string; metadata: Record<string, unknown> }
    expect(result.metadata.status).toBe('error')
    expect(result.metadata.stderr).toBe('Kaivo app unreachable')
    expect(result.metadata.exit_code).toBe(1)
  })

  it('kaivo_pty: mutation returns shellId; metadata emits it', async () => {
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
    const cloudPty = hooks.tool!.kaivo_pty!
    const result = (await cloudPty.execute(
      { cwd: '/tmp' },
      ctx as never,
    )) as { output: string; metadata: Record<string, unknown> }
    expect(result.metadata.kaivo_shell_id).toBe('pty-42')
    expect(ctx.metadataCalls.at(0)?.metadata?.kaivo_shell_id).toBe('pty-42')
  })

  it('kaivo_pty_list: queries shells for the current opencode session', async () => {
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
    const result = (await hooks.tool!.kaivo_pty_list!.execute(
      {},
      makeCtx('oc-list') as never,
    )) as { output: string; metadata: Record<string, unknown> }

    expect(result.output).toContain('pty-42 alive cwd="/tmp/project"')
    expect(result.output).toContain('title="npm run dev"')
    expect(result.metadata.count).toBe(1)
    expect(result.metadata.shell_ids).toEqual(['pty-42'])
  })

  it('kaivo_open_pane: mutation publishes pane intent', async () => {
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
    const result = (await hooks.tool!.kaivo_open_pane!.execute(
      { kind: 'file', path: '/src/app.ts', title: 'app.ts', activate: true },
      makeCtx('oc-pane') as never,
    )) as { output: string; metadata: Record<string, unknown> }

    expect(result.output).toBe('Opened file pane /src/app.ts.')
    expect(result.metadata.status).toBe('success')
    expect(result.metadata.pane_type).toBe('file')
  })

  it('kaivo_open_pane: browser mutation publishes pane intent', async () => {
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
    const result = (await hooks.tool!.kaivo_open_pane!.execute(
      { kind: 'browser', url: 'https://example.com', title: 'Example', activate: true },
      makeCtx('oc-browser-pane') as never,
    )) as { output: string; metadata: Record<string, unknown> }

    expect(result.output).toBe('Opened browser pane https://example.com.')
    expect(result.metadata.status).toBe('success')
    expect(result.metadata.pane_type).toBe('browser')
  })

  it('kaivo_open_pane: omits empty title', async () => {
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
    await hooks.tool!.kaivo_open_pane!.execute(
      { kind: 'file', path: 'src/app.ts', title: '' },
      makeCtx('oc-empty-title') as never,
    )
  })

  it('kaivo_pty: structured error on unreachable app', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const hooks = buildHooks({
      tokenOverride: 't',
      appUrlOverride: 'http://nope',
      fetchImpl,
      backoffMs: [1, 1],
    })
    const result = (await hooks.tool!.kaivo_pty!.execute(
      {},
      makeCtx() as never,
    )) as { output: string; metadata: Record<string, unknown> }
    expect(result.metadata.status).toBe('error')
    expect(result.metadata.stderr).toBe('Kaivo app unreachable')
  })

  it('kaivo_bash: tolerates 401 auth rejection without infinite retry', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch
    const hooks = buildHooks({
      tokenOverride: 'bad',
      appUrlOverride: 'http://app:3000',
      fetchImpl,
      backoffMs: [],
    })
    const result = (await hooks.tool!.kaivo_bash!.execute(
      { command: 'x' },
      makeCtx() as never,
    )) as { output: string; metadata: Record<string, unknown> }
    expect(result.metadata.status).toBe('error')
    expect(typeof result.metadata.stderr).toBe('string')
  })
})
