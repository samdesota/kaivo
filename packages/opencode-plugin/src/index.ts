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
    `[cloud-code-plugin] registering cloud_bash, cloud_pty, cloud_pty_write, cloud_pty_read, cloud_pty_close (appUrl=${creds.appUrl})`,
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
          'Run a finite shell command inside the cloud-code sandbox and wait for it to exit. Good for build steps, tests, git, curl probes, and any command that terminates on its own. For long-running or interactive processes (dev servers, watch modes, REPLs, tail -f) use `cloud_pty` instead so the human can see and interact with them.',
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
          'Open a persistent interactive PTY shell inside the cloud-code sandbox. Prefer this for dev servers, watch commands, REPLs, or anything that runs indefinitely — the shell appears in the human user\'s Shells panel so they can watch output and type into it. Returns a shellId you can then use with `cloud_pty_write` to send commands or `cloud_pty_read` to check output. Once a PTY is open, DO NOT run the same long-running command via cloud_bash.',
        args: {
          cwd: z.string().optional().describe('Starting cwd for the shell. Defaults to /workspace.'),
          label: z.string().optional().describe('Short human-readable label shown in the Shells panel.'),
          cols: z.number().int().optional(),
          rows: z.number().int().optional(),
        },
        async execute(args, context) {
          return runCloudPty(client, args, context as unknown as ToolCtxLike)
        },
      }),
      cloud_pty_write: tool({
        description:
          'Send text input to an already-opened PTY shell (created with `cloud_pty`). Use this to run commands inside a persistent shell instead of spawning new ones. By default a trailing newline is appended so the shell executes the line.',
        args: {
          shellId: z.string().describe('Shell id returned by cloud_pty.'),
          input: z
            .string()
            .describe('Text to send. Control characters like "\\x03" for Ctrl-C are allowed.'),
          appendNewline: z
            .boolean()
            .optional()
            .describe('Append "\\n" after input to execute the line. Defaults to true.'),
        },
        async execute(args, context) {
          return runCloudPtyWrite(client, args, context as unknown as ToolCtxLike)
        },
      }),
      cloud_pty_read: tool({
        description:
          'Read the most recent output from a PTY shell. Returns the last `maxBytes` of scrollback, whether the shell is still alive, and the exit code if it exited. Use after `cloud_pty_write` or to poll progress of a long-running process.',
        args: {
          shellId: z.string().describe('Shell id returned by cloud_pty.'),
          maxBytes: z
            .number()
            .int()
            .optional()
            .describe('Max bytes of tail output to return. Defaults to 8192.'),
        },
        async execute(args, context) {
          return runCloudPtyRead(client, args, context as unknown as ToolCtxLike)
        },
      }),
      cloud_pty_close: tool({
        description:
          'Terminate a PTY shell created with `cloud_pty` and dispose it. Call when the process is no longer needed so the Shells panel stays tidy.',
        args: {
          shellId: z.string().describe('Shell id returned by cloud_pty.'),
        },
        async execute(args, context) {
          return runCloudPtyClose(client, args, context as unknown as ToolCtxLike)
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

async function runCloudPtyWrite(
  client: AgentShellClient,
  args: { shellId: string; input: string; appendNewline?: boolean },
  _ctx: ToolCtxLike,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  try {
    const line = args.appendNewline === false ? args.input : `${args.input}\n`
    const b64 = Buffer.from(line, 'utf8').toString('base64')
    await client.mutate<{ ok: true }>('agentShell.write', {
      shellId: args.shellId,
      b64,
    })
    return {
      output: `Wrote ${line.length} bytes to shell ${args.shellId}.`,
      metadata: { cloudcode_shell_id: args.shellId, status: 'ok' },
    }
  } catch (err) {
    return ptyError(args.shellId, err)
  }
}

async function runCloudPtyRead(
  client: AgentShellClient,
  args: { shellId: string; maxBytes?: number },
  _ctx: ToolCtxLike,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  try {
    const res = await client.query<{
      b64: string
      truncated: boolean
      exitCode: number | null
      alive: boolean
    }>('agentShell.tail', {
      shellId: args.shellId,
      maxBytes: args.maxBytes ?? 8192,
    })
    const text = Buffer.from(res.b64, 'base64').toString('utf8')
    return {
      output: text,
      metadata: {
        cloudcode_shell_id: args.shellId,
        alive: res.alive,
        exit_code: res.exitCode,
        truncated: res.truncated,
      },
    }
  } catch (err) {
    return ptyError(args.shellId, err)
  }
}

async function runCloudPtyClose(
  client: AgentShellClient,
  args: { shellId: string },
  _ctx: ToolCtxLike,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  try {
    await client.mutate<{ ok: true }>('agentShell.close', { shellId: args.shellId })
    return {
      output: `Shell ${args.shellId} closed.`,
      metadata: { cloudcode_shell_id: args.shellId, status: 'closed' },
    }
  } catch (err) {
    return ptyError(args.shellId, err)
  }
}

function ptyError(shellId: string, err: unknown): { output: string; metadata: Record<string, unknown> } {
  if (err instanceof AppUnreachableError) {
    return {
      output: '',
      metadata: {
        cloudcode_shell_id: shellId,
        status: 'error',
        stderr: 'cloud-code app unreachable',
        error: err.message,
      },
    }
  }
  return {
    output: '',
    metadata: {
      cloudcode_shell_id: shellId,
      status: 'error',
      stderr: (err as Error).message,
    },
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
