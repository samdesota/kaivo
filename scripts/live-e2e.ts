/**
 * Live e2e harness — exercises the agent against a real (fast) model.
 *
 * Boots a real sandbox, talks to opencode through the app's proxy via
 * @opencode-ai/sdk, and runs each case in a fresh agent session. Single
 * sandbox is reused across cases (sandbox spin-up is the slow part).
 *
 * Env:
 *   APP_URL           default http://127.0.0.1:3000
 *   ADMIN_PASSWORD    required
 *   E2E_KEEP_SANDBOX  set to skip teardown (post-mortem inspection)
 *   E2E_ONLY          comma-sep substring filter (e.g. "task,bash")
 *
 * Run: ADMIN_PASSWORD=… bun run scripts/live-e2e.ts
 */

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'

const APP_URL = (process.env.APP_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const KEEP = !!process.env.E2E_KEEP_SANDBOX
const ONLY = (process.env.E2E_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const MODEL = { providerID: 'anthropic', modelID: 'claude-haiku-4-5-20251001' }

// ---------- tiny logger / assert ------------------------------------------

function ts() {
  return new Date().toISOString().slice(11, 19)
}
function log(line: string, data?: Record<string, unknown>) {
  if (data) console.log(`[${ts()}] ${line}`, data)
  else console.log(`[${ts()}] ${line}`)
}
function die(msg: string): never {
  log(`FATAL: ${msg}`)
  process.exit(1)
}
function req(name: string, v: string | undefined): string {
  if (!v) die(`env ${name} required`)
  return v
}

// ---------- tRPC over HTTP (cookie auth) ----------------------------------

let cookie = ''
function sj(v: unknown) {
  return { json: v }
}
async function tMutate<T>(proc: string, input: unknown): Promise<T> {
  const res = await fetch(`${APP_URL}/trpc/${proc}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(sj(input)),
  })
  const c = res.headers.get('set-cookie')
  if (c) cookie = c.split(',')[0]!.split(';')[0]!
  const b = (await res.json()) as { result?: { data?: { json?: unknown } }; error?: { message?: string } }
  if (b.error) throw new Error(`${proc}: ${b.error.message}`)
  return (b.result?.data?.json ?? b.result?.data) as T
}
async function tQuery<T>(proc: string, input: unknown): Promise<T> {
  const qp = new URLSearchParams({ input: JSON.stringify(sj(input)) })
  const res = await fetch(`${APP_URL}/trpc/${proc}?${qp.toString()}`, {
    headers: cookie ? { Cookie: cookie } : {},
  })
  const b = (await res.json()) as { result?: { data?: { json?: unknown } }; error?: { message?: string } }
  if (b.error) throw new Error(`${proc}: ${b.error.message}`)
  return (b.result?.data?.json ?? b.result?.data) as T
}

async function waitFor<T>(
  label: string,
  f: () => Promise<T | null>,
  timeoutMs = 60_000,
  pollMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await f().catch(() => null)
    if (r !== null) return r
    await new Promise((r) => setTimeout(r, pollMs))
  }
  die(`timeout waiting for ${label}`)
}

// ---------- shared per-case primitives ------------------------------------

interface ToolState {
  status?: string
  input?: Record<string, unknown>
  output?: string
  metadata?: Record<string, unknown>
}
interface Part {
  type: string
  tool?: string
  callID?: string
  text?: string
  state?: ToolState
  sessionID?: string
}
interface Event {
  type: string
  properties?: { part?: Part; sessionID?: string; info?: { sessionID?: string }; error?: unknown }
}

interface CaseCtx {
  client: OpencodeClient
  sandboxId: string
}

interface PromptResult {
  parts: Part[]
  /** Concatenated text parts from assistant messages, in order. */
  text: string
  childSessionIds: string[]
}

/**
 * Send a single prompt in a fresh session and drain events until idle.
 * Returns the full part list seen on the prompted session (parent only —
 * subagent sessions are reported via `childSessionIds` instead).
 */
async function promptOnce(
  ctx: CaseCtx,
  prompt: string,
  opts: { tools?: Record<string, boolean>; timeoutMs?: number } = {},
): Promise<PromptResult> {
  const { client } = ctx
  const eventStream = await client.event.subscribe({ throwOnError: true })
  const sessionRes = await client.session.create({ body: {}, throwOnError: true })
  const ocSessionId = sessionRes.data.id

  const promptPromise = client.session.promptAsync({
    path: { id: ocSessionId },
    body: {
      parts: [{ type: 'text', text: prompt }],
      tools: opts.tools ?? { bash: false, cloud_bash: true, cloud_pty: true },
      model: MODEL,
    },
    throwOnError: true,
  })
  promptPromise.catch((err) => log(`  promptAsync error: ${(err as Error).message ?? err}`))

  const partsById = new Map<string, Part>()
  const partOrder: string[] = []
  const childSessions = new Set<string>()
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000)

  for await (const raw of eventStream.stream as AsyncGenerator<unknown>) {
    if (Date.now() > deadline) die(`prompt timeout after ${(opts.timeoutMs ?? 90_000) / 1000}s`)
    const evt = raw as Event
    if (evt.type === 'session.created' || evt.type === 'session.updated') {
      const info = (evt.properties as { info?: { id?: string; parentID?: string } } | undefined)?.info
      if (info?.id && (info as { parentID?: string }).parentID === ocSessionId) {
        childSessions.add(info.id)
      }
      continue
    }
    if (evt.type === 'session.error' && evt.properties?.sessionID === ocSessionId) {
      die(`session.error: ${JSON.stringify(evt.properties.error)}`)
    }
    if (evt.type === 'session.idle' && evt.properties?.sessionID === ocSessionId) {
      break
    }
    if (evt.type !== 'message.part.updated') continue
    const p = evt.properties?.part
    if (!p) continue
    if (p.sessionID !== ocSessionId) continue
    const id = (p as { id?: string }).id
    if (!id) continue
    if (!partsById.has(id)) partOrder.push(id)
    partsById.set(id, { ...partsById.get(id), ...p })
  }

  const parts = partOrder.map((id) => partsById.get(id)!).filter(Boolean)
  const text = parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text!)
    .join('')

  return { parts, text, childSessionIds: [...childSessions] }
}

// ---------- cases ---------------------------------------------------------

interface CaseDef {
  name: string
  run: (ctx: CaseCtx) => Promise<void>
}

const cases: CaseDef[] = [
  {
    name: 'chat: trivial arithmetic round-trip',
    async run(ctx) {
      const r = await promptOnce(
        ctx,
        'Reply with exactly the digit "4" and nothing else. What is 2 + 2?',
        { tools: { bash: false, cloud_bash: false, cloud_pty: false } },
      )
      if (!r.text.trim()) throw new Error('no assistant text in reply')
      if (!/4/.test(r.text)) throw new Error(`expected "4" in reply, got: ${r.text.slice(0, 200)}`)
    },
  },
  {
    name: 'tool: cloud_bash echoes a marker',
    async run(ctx) {
      const marker = `E2E_${Date.now().toString(36).toUpperCase()}`
      const r = await promptOnce(
        ctx,
        `Run the shell command: echo ${marker}. Use cloud_bash.`,
      )
      const tool = r.parts.find(
        (p) => p.type === 'tool' && p.tool === 'cloud_bash' && p.state?.status === 'completed',
      )
      if (!tool) throw new Error('no completed cloud_bash tool part in transcript')
      const out = tool.state?.output ?? ''
      if (!out.includes(marker)) throw new Error(`output missing marker ${marker}: ${out.slice(0, 200)}`)
    },
  },
  {
    name: 'subagent: task tool spawns a child session',
    async run(ctx) {
      // Force the model to use the task tool. Haiku is cheap so we ask for a
      // trivial subagent call. Asserts the parent↔child wiring (the new
      // streaming feature) is intact: a child session shows up on the
      // event stream under this prompt's parent.
      const r = await promptOnce(
        ctx,
        'Use the task tool to spawn a general subagent that simply replies with the word "done". Use the task tool.',
        // Block bash so the model can't shortcut around `task`.
        { tools: { bash: false, cloud_bash: false, cloud_pty: false } },
        )
      const taskCall = r.parts.find((p) => p.type === 'tool' && p.tool === 'task')
      if (!taskCall) {
        throw new Error('model did not call the task tool')
      }
      if (r.childSessionIds.length === 0) {
        throw new Error('task tool fired but no child session.created event observed')
      }
    },
  },
]

// ---------- main ----------------------------------------------------------

async function main(): Promise<void> {
  const password = req('ADMIN_PASSWORD', ADMIN_PASSWORD)

  log(`APP_URL=${APP_URL}`)
  log('login')
  await tMutate<{ ok: true }>('auth.login', { password })

  log('create sandbox')
  const sb = await tMutate<{ id: string }>('sandbox.create', {
    name: `e2e-${Date.now().toString(36)}`,
  })
  const sandboxId = sb.id
  log(`  id=${sandboxId}`)

  let firstFailure: string | null = null
  try {
    log('wait for opencode ready')
    await waitFor(
      'opencode ready',
      async () => {
        const s = await tQuery<{ ready: boolean; hasProvider: boolean }>('agent.agentStatus', {
          sandboxId,
        })
        if (!s.hasProvider) die('no anthropic provider configured for admin')
        return s.ready ? s : null
      },
      120_000,
    )

    const client = createOpencodeClient({
      baseUrl: `${APP_URL}/sandbox/${sandboxId}/agent`,
      headers: { Cookie: cookie },
    })
    const ctx: CaseCtx = { client, sandboxId }

    const filtered = ONLY.length > 0
      ? cases.filter((c) => ONLY.some((needle) => c.name.toLowerCase().includes(needle.toLowerCase())))
      : cases

    if (filtered.length === 0) die(`no cases match E2E_ONLY=${ONLY.join(',')}`)

    let pass = 0
    let fail = 0
    for (const c of filtered) {
      const t0 = Date.now()
      log(`▶ ${c.name}`)
      try {
        await c.run(ctx)
        const dt = ((Date.now() - t0) / 1000).toFixed(1)
        log(`  ✓ PASS  (${dt}s)`)
        pass++
      } catch (err) {
        const dt = ((Date.now() - t0) / 1000).toFixed(1)
        const msg = (err as Error).message ?? String(err)
        log(`  ✗ FAIL  (${dt}s): ${msg}`)
        fail++
        if (!firstFailure) firstFailure = `${c.name}: ${msg}`
      }
    }
    log(`results: ${pass} pass, ${fail} fail`)
  } finally {
    if (sandboxId && !KEEP) {
      log(`cleanup: archive + delete sandbox ${sandboxId}`)
      await tMutate('sandbox.archive', { id: sandboxId }).catch(() => undefined)
      await tMutate('sandbox.delete', { id: sandboxId }).catch(() => undefined)
    } else if (sandboxId) {
      log(`E2E_KEEP_SANDBOX set — leaving sandbox ${sandboxId}`)
    }
  }

  if (firstFailure) {
    log('=========== FAIL ===========')
    process.exit(1)
  }
  log('=========== PASS ===========')
}

main().catch((err) => {
  console.error('unexpected error:', err)
  process.exit(2)
})
