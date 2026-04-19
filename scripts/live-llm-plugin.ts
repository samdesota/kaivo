/**
 * Live-LLM end-to-end test for the OpenCode plugin.
 *
 * Drives the full loop end-to-end:
 *   1. Login to the running app.
 *   2. Create a fresh sandbox.
 *   3. Wait for the sandbox + opencode-serve to be ready.
 *   4. Start an agent session pinned to Claude Haiku 4.5 with a prompt
 *      that directs the agent to use our `cloud_bash` tool.
 *   5. Poll the DB for a `shell_sessions` row with `owner_kind='agent'`.
 *   6. Tail the agent shell via `agentShell.tail` and check for our marker.
 *   7. Clean up (archive + delete the sandbox).
 *
 * This is intentionally out of CI — LLMs are non-deterministic and each
 * run costs credits. Run manually with the `test:live-llm` script.
 *
 * Env:
 *   APP_URL           default http://127.0.0.1:3100
 *   ADMIN_PASSWORD    required
 *   DATABASE_URL      required (for direct DB polling)
 *   TIMEOUT_MS        default 120_000
 */

import { Pool } from 'pg'

const APP_URL = (process.env.APP_URL ?? 'http://127.0.0.1:3100').replace(/\/+$/, '')
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const DATABASE_URL = process.env.DATABASE_URL
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 120_000)

const MARKER = `LIVE_LLM_MARKER_${Date.now().toString(36)}`

// Anthropic provider ID + haiku model — fast + cheap.
const MODEL = { providerID: 'anthropic', modelID: 'claude-haiku-4-5-20251001' }

function log(line: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString().slice(11, 19)
  if (data) console.log(`[${ts}] ${line}`, data)
  else console.log(`[${ts}] ${line}`)
}

function die(msg: string, data?: Record<string, unknown>): never {
  log(`FAIL ${msg}`, data)
  process.exit(1)
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) die(`env ${name} is required`)
  return value
}

// ---------- minimal tRPC-over-HTTP client w/ cookie jar ----------

let cookie: string | null = null

function grabCookie(headers: Headers): void {
  const set = headers.get('set-cookie')
  if (!set) return
  // Take the first cookie chunk (name=value; Path=/; ...)
  const first = set.split(',')[0]?.split(';')[0]?.trim()
  if (first) cookie = first
}

function sjEncode(v: unknown): unknown {
  return { json: v }
}
function sjDecode(p: unknown): unknown {
  if (p && typeof p === 'object' && 'json' in (p as Record<string, unknown>)) {
    return (p as { json: unknown }).json
  }
  return p
}

async function trpcMutate<T>(procedure: string, input: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(`${APP_URL}/trpc/${procedure}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(sjEncode(input)),
  })
  grabCookie(res.headers)
  const body = (await res.json()) as {
    result?: { data?: unknown }
    error?: { message?: string }
  }
  if (body.error) throw new Error(`${procedure}: ${body.error.message ?? 'error'}`)
  return sjDecode(body.result?.data) as T
}

async function trpcQuery<T>(procedure: string, input: Record<string, unknown>): Promise<T> {
  const qp = new URLSearchParams({ input: JSON.stringify(sjEncode(input)) })
  const headers: Record<string, string> = {}
  if (cookie) headers.Cookie = cookie
  const res = await fetch(`${APP_URL}/trpc/${procedure}?${qp.toString()}`, {
    method: 'GET',
    headers,
  })
  grabCookie(res.headers)
  const body = (await res.json()) as {
    result?: { data?: unknown }
    error?: { message?: string }
  }
  if (body.error) throw new Error(`${procedure}: ${body.error.message ?? 'error'}`)
  return sjDecode(body.result?.data) as T
}

// ---------- helpers ----------

async function waitFor<T>(
  label: string,
  predicate: () => Promise<T | null>,
  timeoutMs: number,
  pollMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  while (Date.now() < deadline) {
    attempt += 1
    try {
      const v = await predicate()
      if (v !== null) return v
    } catch (err) {
      log(`${label} poll error (attempt ${attempt}): ${(err as Error).message}`)
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  die(`timed out waiting for ${label} after ${timeoutMs}ms`)
}

// ---------- test ----------

async function main(): Promise<void> {
  const password = requireEnv('ADMIN_PASSWORD', ADMIN_PASSWORD)
  const dbUrl = requireEnv('DATABASE_URL', DATABASE_URL)

  log(`STEP 1/7: login at ${APP_URL}`)
  await trpcMutate<{ ok: true }>('auth.login', { password })
  if (!cookie) die('login succeeded but no cookie returned')
  log('  ✓ logged in')

  const pool = new Pool({ connectionString: dbUrl })
  let sandboxId: string | null = null
  let failedReason: string | null = null
  try {
    log('STEP 2/7: create sandbox')
    const sb = await trpcMutate<{ id: string; name: string }>('sandbox.create', {
      name: `live-llm-${Date.now().toString(36)}`,
    })
    sandboxId = sb.id
    log(`  ✓ sandbox created id=${sandboxId} name=${sb.name}`)

    log('STEP 3/7: wait for sandbox to be running')
    await waitFor(
      'sandbox running',
      async () => {
        const s = await trpcQuery<{ running: boolean; status: string }>('sandbox.get', {
          id: sandboxId!,
        })
        return s.running ? s : null
      },
      30_000,
    )
    log('  ✓ sandbox running')

    log('STEP 4/7: wait for opencode ready')
    await waitFor(
      'opencode ready',
      async () => {
        const s = await trpcQuery<{ ready: boolean; hasProvider: boolean }>(
          'agent.agentStatus',
          { sandboxId: sandboxId! },
        )
        if (!s.hasProvider) die('no provider configured on the app (set Anthropic API key)')
        return s.ready ? s : null
      },
      30_000,
    )
    log('  ✓ opencode ready')

    log(`STEP 5/7: start agent session pinned to ${MODEL.modelID}`)
    const prompt =
      `You are running in a cloud-code sandbox. Call the \`cloud_bash\` tool ` +
      `EXACTLY ONCE with command: echo ${MARKER} && uname -a. Do not use any other tool. ` +
      `After the tool returns, reply with a one-sentence summary.`
    const session = await trpcMutate<{ id: string; opencodeSessionId: string }>(
      'agent.sessionStart',
      { sandboxId: sandboxId!, prompt, model: MODEL },
    )
    log(`  ✓ session started id=${session.id} oc=${session.opencodeSessionId}`)

    log('STEP 6/7: wait for agent to invoke cloud_bash (agent shell row appears)')
    const shellRow = await waitFor(
      'agent shell row',
      async () => {
        const { rows } = await pool.query<{ id: string; owner_kind: string }>(
          `SELECT id, owner_kind FROM shell_sessions
             WHERE sandbox_id = $1 AND owner_kind = 'agent'
             ORDER BY created_at DESC
             LIMIT 1`,
          [sandboxId],
        )
        return rows[0] ?? null
      },
      TIMEOUT_MS,
      2_000,
    )
    log(`  ✓ found agent shell: id=${shellRow.id}`)

    log('STEP 7/7: tail the agent shell and look for the marker')
    const tail = await waitFor(
      'shell output contains marker',
      async () => {
        try {
          const t = await trpcQuery<{ b64: string; exitCode: number | null; alive: boolean }>(
            'agentShell.tail',
            { shellId: shellRow.id, sandboxId: sandboxId!, maxBytes: 64 * 1024 },
          )
          const txt = Buffer.from(t.b64, 'base64').toString('utf8')
          if (txt.includes(MARKER)) return { ...t, txt }
        } catch (err) {
          // Shell may have been disposed (past retention) — retry once the
          // transcript lands; for this test the retention is 10 min so this
          // should be fine.
          void err
        }
        return null
      },
      TIMEOUT_MS,
      2_000,
    )
    log(`  ✓ marker present; shell exitCode=${tail.exitCode} alive=${tail.alive}`)
    log(
      `  tail snippet: ${tail.txt.slice(Math.max(0, tail.txt.indexOf(MARKER) - 40), tail.txt.indexOf(MARKER) + MARKER.length + 40)}`,
    )

    log('=========== PASS ===========')
    log('Plugin live-LLM e2e succeeded.')
  } catch (err) {
    failedReason = (err as Error).message ?? String(err)
  } finally {
    if (sandboxId && !process.env.LIVE_LLM_KEEP_SANDBOX) {
      log(`cleanup: archive + delete sandbox ${sandboxId}`)
      await trpcMutate('sandbox.archive', { id: sandboxId }).catch(() => undefined)
      await trpcMutate('sandbox.delete', { id: sandboxId }).catch(() => undefined)
    } else if (sandboxId) {
      log(`LIVE_LLM_KEEP_SANDBOX set — leaving sandbox ${sandboxId} for inspection`)
    }
    await pool.end().catch(() => undefined)
  }

  if (failedReason) die(failedReason)
}

main().catch((err) => {
  console.error('unexpected error:', err)
  process.exit(2)
})
