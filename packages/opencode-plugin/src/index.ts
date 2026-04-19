import { z } from 'zod'
import { tool, type Plugin, type Hooks } from '@opencode-ai/plugin'
import { AgentShellClient, AppUnreachableError } from './client.js'

/**
 * Tool-name collision: OpenCode ships a built-in `bash` tool that shells
 * out locally. We can't replace it from a plugin in a way that also
 * surfaces our shellId metadata to the cloud-code UI, so we expose our
 * tools under `cloud_bash` and `cloud_pty` and teach the system prompt to
 * prefer them. The `plugin` config entry is always paired with an agent
 * prompt that mentions these names.
 */

const TOKEN_ENV = 'CLOUDCODE_AGENT_TOKEN'
const APP_URL_ENV = 'CLOUDCODE_APP_URL'

function readEnv(): { token: string; appUrl: string } | null {
  const token = process.env[TOKEN_ENV]
  const appUrl = process.env[APP_URL_ENV]
  if (!token || !appUrl) return null
  return { token, appUrl }
}

interface ToolCtxLike {
  sessionID: string
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void
  abort: AbortSignal
}

/** For tests: inject a custom fetch. */
export interface BuildHookOpts {
  fetchImpl?: typeof fetch
  appUrlOverride?: string
  tokenOverride?: string
  backoffMs?: number[]
}

export function buildHooks(opts: BuildHookOpts = {}): Hooks {
  const creds =
    opts.tokenOverride && opts.appUrlOverride
      ? { token: opts.tokenOverride, appUrl: opts.appUrlOverride }
      : readEnv()
  if (!creds) {
    // Credentials absent: tools won't be registered. Agent falls back to
    // OpenCode's own bash tool. Log so operators can see why.
    const tokenSet = !!process.env[TOKEN_ENV]
    const urlSet = !!process.env[APP_URL_ENV]
    console.error(
      `[cloud-code-plugin] env missing — tokenSet=${tokenSet} urlSet=${urlSet}; tools not registered`,
    )
    return {}
  }
  console.error(
    `[cloud-code-plugin] registering cloud_bash + cloud_pty (appUrl=${creds.appUrl})`,
  )
  const client = new AgentShellClient({
    appUrl: creds.appUrl,
    token: creds.token,
    fetchImpl: opts.fetchImpl,
    backoffMs: opts.backoffMs,
  })

  return {
    tool: {
      cloud_bash: tool({
        description:
          'Run a shell command inside the cloud-code sandbox. Streams stdout+stderr to the UI and returns combined output plus exit code.',
        args: {
          command: z
            .string()
            .describe('The shell command to run, evaluated by bash -lc.'),
          cwd: z.string().optional().describe('Working directory. Defaults to /workspace.'),
        },
        async execute(args, context) {
          return runCloudBash(client, args, context as unknown as ToolCtxLike)
        },
      }),
      cloud_pty: tool({
        description:
          'Open a persistent PTY shell inside the cloud-code sandbox that the human user can also attach to. Returns the shell id.',
        args: {
          cwd: z.string().optional().describe('Starting cwd for the shell. Defaults to /workspace.'),
          cols: z.number().int().optional(),
          rows: z.number().int().optional(),
        },
        async execute(args, context) {
          return runCloudPty(client, args, context as unknown as ToolCtxLike)
        },
      }),
    },
  }
}

async function runCloudBash(
  client: AgentShellClient,
  args: { command: string; cwd?: string },
  ctx: ToolCtxLike,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  try {
    let shellId: string | null = null
    let exitCode: number | null = null
    let truncated = false
    const chunks: string[] = []

    for await (const evt of client.subscribe(
      'agentShell.runOnce',
      {
        cmd: args.command,
        cwd: args.cwd,
        opencodeSessionId: ctx.sessionID,
      },
      ctx.abort,
    )) {
      if (evt.type === 'started' && evt.shellId) {
        shellId = evt.shellId
        ctx.metadata({
          title: `$ ${truncateTitle(args.command)}`,
          metadata: { cloudcode_shell_id: shellId, status: 'running' },
        })
      } else if (evt.type === 'stdout' || evt.type === 'stderr') {
        if (evt.b64) {
          const str = Buffer.from(evt.b64, 'base64').toString('utf8')
          chunks.push(str)
        }
      } else if (evt.type === 'exit') {
        exitCode = evt.code ?? 0
        truncated = evt.truncated ?? false
      }
    }

    const output = chunks.join('')
    const result = {
      output,
      metadata: {
        cloudcode_shell_id: shellId,
        exit_code: exitCode ?? 0,
        truncated,
      },
    }
    ctx.metadata({
      title: `$ ${truncateTitle(args.command)}`,
      metadata: { ...result.metadata, status: exitCode === 0 ? 'success' : 'failed' },
    })
    return result
  } catch (err) {
    if (err instanceof AppUnreachableError) {
      return {
        output: '',
        metadata: {
          cloudcode_shell_id: null,
          exit_code: 1,
          status: 'error',
          stderr: 'cloud-code app unreachable',
          error: err.message,
        },
      }
    }
    return {
      output: '',
      metadata: {
        cloudcode_shell_id: null,
        exit_code: 1,
        status: 'error',
        stderr: (err as Error).message,
      },
    }
  }
}

async function runCloudPty(
  client: AgentShellClient,
  args: { cwd?: string; cols?: number; rows?: number },
  ctx: ToolCtxLike,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  try {
    const { shellId } = await client.mutate<{ shellId: string }>('agentShell.open', {
      cwd: args.cwd,
      cols: args.cols,
      rows: args.rows,
      opencodeSessionId: ctx.sessionID,
    })
    ctx.metadata({
      title: `shell ${shellId.slice(-8)}`,
      metadata: { cloudcode_shell_id: shellId, status: 'running' },
    })
    return {
      output: `Shell ${shellId} opened in the cloud-code sandbox.`,
      metadata: { cloudcode_shell_id: shellId, status: 'running' },
    }
  } catch (err) {
    if (err instanceof AppUnreachableError) {
      return {
        output: '',
        metadata: {
          cloudcode_shell_id: null,
          status: 'error',
          stderr: 'cloud-code app unreachable',
          error: err.message,
        },
      }
    }
    return {
      output: '',
      metadata: {
        cloudcode_shell_id: null,
        status: 'error',
        stderr: (err as Error).message,
      },
    }
  }
}

function truncateTitle(s: string): string {
  const trimmed = s.trim().replace(/\s+/g, ' ')
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed
}

/**
 * OpenCode plugin entry. Returns hooks populated iff the env vars are set;
 * otherwise registers nothing and leaves the built-in tools intact.
 */
const plugin: Plugin = async () => buildHooks()

/**
 * OpenCode requires path-based (file://) plugins to export an `id` so the
 * plugin system can key hooks and reloads on it. Without this field,
 * 1.4.14's loader logs `must export id  failed to load plugin` and skips
 * hook registration entirely — the tools silently don't show up.
 */
export default { id: 'cloud-code', server: plugin }
export { plugin }
