/**
 * Live-LLM plugin smoke test — SDK-driven, event-based.
 *
 * Talks to OpenCode running inside a sandbox via the app's agent proxy,
 * using the @opencode-ai/sdk directly. No polling for results — we watch
 * the real-time event stream and react as soon as a tool part lands.
 *
 * What it proves, in order:
 *   1. Plugin bundle is loaded by opencode  (GET /config → plugin_origins)
 *   2. `cloud_bash` is a registered tool (forced tool choice in session body)
 *   3. The plugin's `execute` hits our app (shell_sessions row with
 *      owner_kind='agent' and the tool part's metadata.cloudcode_shell_id
 *      matches it)
 *   4. Tool output flows back through the plugin (part.state.output)
 *
 * Env:
 *   APP_URL           default http://127.0.0.1:3000
 *   ADMIN_PASSWORD    required
 *   DATABASE_URL      required (for the final shell-row assertion)
 *   LIVE_LLM_KEEP_SANDBOX=1  skip cleanup (for post-mortem)
 */

import { createOpencodeClient } from '@opencode-ai/sdk'
import { Pool } from 'pg'

const APP_URL = (process.env.APP_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const DATABASE_URL = process.env.DATABASE_URL
const MARKER = `LIVE_LLM_${Date.now().toString(36).toUpperCase()}`
const MODEL = { providerID: 'anthropic', modelID: 'claude-haiku-4-5-20251001' }

function log(line: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString().slice(11, 19)
  if (data) console.log(`[${ts}] ${line}`, data)
  else console.log(`[${ts}] ${line}`)
}
function die(msg: string): never {
  log(`FAIL: ${msg}`)
  process.exit(1)
}
function req(name: string, v: string | undefined): string {
  if (!v) die(`env ${name} required`)
  return v
}

// ---------- tRPC helpers (cookie auth via login, used only for setup) ----

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

// ---------- main -----------------------------------------------------------

async function main(): Promise<void> {
  const password = req('ADMIN_PASSWORD', ADMIN_PASSWORD)
  const dbUrl = req('DATABASE_URL', DATABASE_URL)
  const pool = new Pool({ connectionString: dbUrl })

  log('login')
  await tMutate<{ ok: true }>('auth.login', { password })

  log('create sandbox')
  const sb = await tMutate<{ id: string }>('sandbox.create', { name: `live-llm-${Date.now().toString(36)}` })
  const sandboxId = sb.id
  log(`  id=${sandboxId}`)

  let failed: string | null = null
  try {
    log('wait for opencode ready')
    await waitFor(
      'opencode ready',
      async () => {
        const s = await tQuery<{ ready: boolean; hasProvider: boolean }>('agent.agentStatus', {
          sandboxId,
        })
        if (!s.hasProvider) die('no anthropic provider configured')
        return s.ready ? s : null
      },
      90_000,
    )

    // Talk to opencode *through our proxy*, which handles Basic auth for us.
    // The proxy strips the client Authorization header and injects the real
    // upstream password itself; we just need to carry the admin cookie.
    const client = createOpencodeClient({
      baseUrl: `${APP_URL}/sandbox/${sandboxId}/agent`,
      headers: { Cookie: cookie },
    })

    // --- L1: plugin loaded? ---
    log('L1: GET /config — is the plugin registered?')
    const cfg = await client.config.get({ throwOnError: true })
    const origins = (cfg.data as { plugin_origins?: Array<{ spec: string }> }).plugin_origins ?? []
    const pluginHit = origins.find((o) => o.spec.includes('cloud-code-plugin'))
    if (!pluginHit) die(`plugin not in config.plugin_origins: ${JSON.stringify(origins)}`)
    log(`  ✓ plugin loaded: ${pluginHit.spec}`)

    // --- L2+L3: prompt with forced tool choice; watch event stream ---
    log('subscribe to event stream')
    const eventStream = await client.event.subscribe({ throwOnError: true })

    log('create session + prompt (cloud_bash forced on; bash disabled)')
    const sessionRes = await client.session.create({ body: {}, throwOnError: true })
    const ocSessionId = sessionRes.data.id
    log(`  oc session=${ocSessionId}`)

    // Fire prompt asynchronously.
    const promptPromise = client.session.promptAsync({
      path: { id: ocSessionId },
      body: {
        parts: [
          {
            type: 'text',
            text: `Run the shell command: echo ${MARKER}. Use any bash-like tool available to you.`,
          },
        ],
        tools: { bash: false, cloud_bash: true, cloud_pty: true },
        model: MODEL,
      },
      throwOnError: true,
    })
    promptPromise.catch((err) => log(`  promptAsync error: ${(err as Error).message ?? err}`))

    log('walking event stream — waiting for completed cloud_bash tool part')
    type ToolState = {
      status?: string
      input?: Record<string, unknown>
      output?: string
      metadata?: { cloudcode_shell_id?: string } & Record<string, unknown>
    }
    type Part = { type: string; tool?: string; callID?: string; state?: ToolState; sessionID?: string }
    type Event = { type: string; properties?: { part?: Part; sessionID?: string; error?: unknown } }

    const deadline = Date.now() + 120_000
    let completed: Part | null = null
    let sawStart = false
    for await (const raw of eventStream.stream as AsyncGenerator<unknown>) {
      if (Date.now() > deadline) die('event-stream timeout (no cloud_bash completion in 120s)')
      const evt = raw as Event
      if (evt.type === 'message.part.updated' && evt.properties?.part) {
        const p = evt.properties.part
        if (p.sessionID && p.sessionID !== ocSessionId) continue
        if (p.type === 'tool') {
          if (!sawStart && p.tool === 'cloud_bash') {
            sawStart = true
            log(`  ▶ cloud_bash started (callID=${p.callID}, status=${p.state?.status})`)
          }
          if (p.tool === 'cloud_bash' && p.state?.status === 'completed') {
            completed = p
            break
          }
          if (p.tool && p.tool !== 'cloud_bash' && p.state?.status !== 'running') {
            die(`LLM used the wrong tool: ${p.tool} (expected cloud_bash)`)
          }
        }
      } else if (evt.type === 'session.error' && evt.properties?.sessionID === ocSessionId) {
        die(`session.error: ${JSON.stringify(evt.properties.error)}`)
      } else if (evt.type === 'session.idle' && evt.properties?.sessionID === ocSessionId) {
        if (!completed) die('session idle without cloud_bash completion')
      }
    }
    if (!completed) die('event stream ended without cloud_bash completion')

    // --- L4: plugin actually talked to our app ---
    log('cloud_bash completed — verifying plugin round-tripped to our app')
    const shellId = completed.state?.metadata?.cloudcode_shell_id
    if (typeof shellId !== 'string' || !shellId) {
      die(`tool completed but metadata.cloudcode_shell_id missing: ${JSON.stringify(completed.state?.metadata)}`)
    }
    log(`  tool.state.metadata.cloudcode_shell_id = ${shellId}`)

    const { rows } = await pool.query<{ id: string; owner_kind: string }>(
      `SELECT id, owner_kind FROM shell_sessions WHERE id = $1 AND sandbox_id = $2`,
      [shellId, sandboxId],
    )
    if (rows.length === 0) die(`no shell_sessions row for shell_id=${shellId}`)
    if (rows[0]!.owner_kind !== 'agent') die(`shell row exists but owner_kind=${rows[0]!.owner_kind}, expected agent`)
    log('  ✓ shell_sessions row confirmed with owner_kind=agent')

    const output = completed.state?.output ?? ''
    if (!output.includes(MARKER)) die(`output missing marker ${MARKER}: ${output.slice(0, 300)}`)
    log(`  ✓ output contains marker ${MARKER}`)

    log('=========== PASS ===========')
  } catch (err) {
    failed = (err as Error).message ?? String(err)
  } finally {
    if (sandboxId && !process.env.LIVE_LLM_KEEP_SANDBOX) {
      log(`cleanup: delete sandbox ${sandboxId}`)
      await tMutate('sandbox.archive', { id: sandboxId }).catch(() => undefined)
      await tMutate('sandbox.delete', { id: sandboxId }).catch(() => undefined)
    } else if (sandboxId) {
      log(`LIVE_LLM_KEEP_SANDBOX set — leaving sandbox ${sandboxId}`)
    }
    await pool.end().catch(() => undefined)
  }

  if (failed) die(failed)
}

main().catch((err) => {
  console.error('unexpected error:', err)
  process.exit(2)
})
