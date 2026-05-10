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
    `[cloud-code-plugin] registering cloud_bash, cloud_pty, cloud_pty_list, cloud_pty_write, cloud_pty_read, cloud_pty_close, cloud_open_pane, cloud_browser_* (appUrl=${creds.appUrl})`,
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
      cloud_pty_list: tool({
        description:
          'List persistent Cloud Code PTY shells in this agent session\'s workspace. Use this before reading or reusing an existing shell. Returns shell ids, cwd, alive/exit state, last activity, and title, which may contain the running command from shell integration.',
        args: {},
        async execute(_args, context) {
          return runCloudPtyList(client, context as unknown as ToolCtxLike)
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
      cloud_open_pane: tool({
        description:
          'Open or focus a right-side pane tab in the Cloud Code UI. Supports file, shell, and browser panes. Use browser panes for web pages and local dev servers. This tool does not read, write, or execute anything by itself.',
        args: {
          kind: z
            .enum(['file', 'shell', 'browser'])
            .describe('Pane type to open: file, shell, or browser.'),
          path: z
            .string()
            .optional()
            .describe(
              'For kind=file: the file to open. A path with NO leading slash (e.g. "src/app.ts") is resolved relative to your current working directory. A path with a leading slash (e.g. "/etc/hosts" or "/Users/sam/notes.md") is treated as an absolute filesystem path.',
            ),
          shellId: z.string().optional().describe('For kind=shell: shell id to open.'),
          url: z.string().optional().describe('For kind=browser: URL to open, including local dev server URLs such as http://127.0.0.1:5173.'),
          title: z.string().optional().describe('Optional short tab title.'),
          activate: z
            .boolean()
            .optional()
            .describe('Whether to focus the opened tab. Defaults to true.'),
        },
        async execute(args, context) {
          return runCloudOpenPane(client, args, context as unknown as ToolCtxLike)
        },
      }),
      cloud_browser_list_tabs: tool({
        description: 'List Cloud Code browser tabs available for agent connection.',
        args: {},
        async execute(_args, context) {
          return runBrowserTool(client, 'agentBrowser.listTabs', {}, context as unknown as ToolCtxLike, 'query')
        },
      }),
      cloud_browser_connect_tab: tool({
        description: 'Connect the agent to an existing Cloud Code browser tab and return a cdpId for subsequent browser tools.',
        args: { browserTabId: z.string().min(1) },
        async execute(args, context) {
          return runBrowserTool(client, 'agentBrowser.connectTab', args, context as unknown as ToolCtxLike, 'mutate')
        },
      }),
      cloud_browser_open_and_connect: tool({
        description: 'Open a URL in a Cloud Code browser tab and connect the agent to it in one step.',
        args: { url: z.string().min(1), title: z.string().optional(), activate: z.boolean().optional() },
        async execute(args, context) {
          return runBrowserTool(client, 'agentBrowser.openAndConnect', args, context as unknown as ToolCtxLike, 'mutate')
        },
      }),
      cloud_browser_disconnect: tool({
        description: 'Disconnect a previously connected browser tab by cdpId.',
        args: { cdpId: z.string().min(1) },
        async execute(args, context) {
          return runBrowserTool(client, 'agentBrowser.disconnect', args, context as unknown as ToolCtxLike, 'mutate')
        },
      }),
      cloud_browser_snapshot: tool({
        description: 'Read a connected browser tab as a semantic tree of interactive elements. Use element IDs from this output with cloud_browser_interact.',
        args: { cdpId: z.string().min(1), filter: z.string().optional(), filterFlags: z.string().optional(), viewportOnly: z.boolean().optional() },
        async execute(args, context) {
          return runBrowserTool(client, 'agentBrowser.snapshot', stripEmptyStrings(args), context as unknown as ToolCtxLike, 'query')
        },
      }),
      cloud_browser_read_logs: tool({
        description: 'Read buffered console logs from a connected browser tab. Logs are collected after the tab is connected with cloud_browser_connect_tab or cloud_browser_open_and_connect.',
        args: { cdpId: z.string().min(1), maxEntries: z.number().int().optional() },
        async execute(args, context) {
          return runBrowserTool(client, 'agentBrowser.readLogs', args, context as unknown as ToolCtxLike, 'query')
        },
      }),
      cloud_browser_interact: tool({
        description: 'Perform a browser action on a connected tab by element ID or navigation action.',
        args: { cdpId: z.string().min(1), action: z.any(), postSnapshot: z.any().optional() },
        async execute(args, context) {
          return runBrowserTool(client, 'agentBrowser.interact', normalizeInteractArgs(args), context as unknown as ToolCtxLike, 'mutate')
        },
      }),
      cloud_browser_screenshot: tool({
        description: 'Capture a screenshot from a connected browser tab.',
        args: { cdpId: z.string().min(1), format: z.enum(['jpeg', 'png']).optional(), quality: z.number().int().optional(), fullPage: z.boolean().optional() },
        async execute(args, context) {
          return runBrowserTool(client, 'agentBrowser.screenshot', args, context as unknown as ToolCtxLike, 'query')
        },
      }),
      cloud_browser_execute_js: tool({
        description: 'Execute JavaScript in a connected browser tab. Prefer snapshot and interact first; use this for explicit inspection or one-off DOM operations.',
        args: { cdpId: z.string().min(1), expression: z.string().min(1), awaitPromise: z.boolean().optional(), timeoutMs: z.number().int().optional() },
        async execute(args, context) {
          return runBrowserTool(client, 'agentBrowser.executeJs', args, context as unknown as ToolCtxLike, 'mutate')
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

type CloudPtyInfo = {
  id: string
  workspaceId: string | null
  cwd: string
  ownerKind: string
  ownerAgentSessionId: string | null
  ownerSessionId: string | null
  exitCode: number | null
  createdAt: unknown
  lastActivityAt: unknown
  alive: boolean
  title: string | null
}

async function runCloudPtyList(
  client: AgentShellClient,
  ctx: ToolCtxLike,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  try {
    const shells = await client.query<CloudPtyInfo[]>('agentShell.list', {
      opencodeSessionId: ctx.sessionID,
    })
    return {
      output: formatPtyList(shells),
      metadata: {
        status: 'success',
        count: shells.length,
        shell_ids: shells.map((shell) => shell.id),
      },
    }
  } catch (err) {
    if (err instanceof AppUnreachableError) {
      return {
        output: '',
        metadata: {
          status: 'error',
          stderr: 'cloud-code app unreachable',
          error: err.message,
        },
      }
    }
    return {
      output: '',
      metadata: {
        status: 'error',
        stderr: (err as Error).message,
      },
    }
  }
}

function formatPtyList(shells: CloudPtyInfo[]): string {
  if (shells.length === 0) return 'No Cloud Code PTY shells are open in this workspace.'
  return shells
    .map((shell) => {
      const status = shell.alive ? 'alive' : `exited ${shell.exitCode ?? 'unknown'}`
      const title = shell.title ? ` title=${JSON.stringify(shell.title)}` : ''
      return `${shell.id} ${status} cwd=${JSON.stringify(shell.cwd)} owner=${shell.ownerKind} lastActivityAt=${String(shell.lastActivityAt)}${title}`
    })
    .join('\n')
}

async function runCloudPtyWrite(
  client: AgentShellClient,
  args: { shellId: string; input: string; appendNewline?: boolean },
  ctx: ToolCtxLike,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  try {
    const line = args.appendNewline === false ? args.input : `${args.input}\n`
    const b64 = Buffer.from(line, 'utf8').toString('base64')
    await client.mutate<{ ok: true }>('agentShell.write', {
      shellId: args.shellId,
      b64,
      opencodeSessionId: ctx.sessionID,
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
  ctx: ToolCtxLike,
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
      opencodeSessionId: ctx.sessionID,
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
  ctx: ToolCtxLike,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  try {
    await client.mutate<{ ok: true }>('agentShell.close', { shellId: args.shellId, opencodeSessionId: ctx.sessionID })
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

async function runCloudOpenPane(
  client: AgentShellClient,
  args: {
    kind: 'file' | 'shell' | 'browser'
    path?: string
    shellId?: string
    url?: string
    title?: string
    activate?: boolean
  },
  ctx: ToolCtxLike,
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  try {
    let content:
      | { type: 'file'; path: string }
      | { type: 'shell'; shellId: string }
      | { type: 'browser'; url?: string }
    if (args.kind === 'file') {
      if (!args.path) throw new Error('path is required for kind=file')
      content = { type: 'file', path: args.path }
    } else if (args.kind === 'shell') {
      if (!args.shellId) throw new Error('shellId is required for kind=shell')
      content = { type: 'shell', shellId: args.shellId }
    } else {
      content = args.url ? { type: 'browser', url: args.url } : { type: 'browser' }
    }

    await client.mutate<{ ok: true }>('agentUi.openPane', {
      opencodeSessionId: ctx.sessionID,
      content,
      title: args.title?.trim() || undefined,
      activate: args.activate,
    })

    const label =
      content.type === 'file'
        ? content.path
        : content.type === 'shell'
          ? content.shellId
          : (content.url ?? 'browser')
    ctx.metadata({
      title: `open ${content.type} ${truncateTitle(label)}`,
      metadata: { status: 'success', pane_type: content.type },
    })
    return {
      output: `Opened ${content.type} pane ${label}.`,
      metadata: { status: 'success', pane_type: content.type },
    }
  } catch (err) {
    return {
      output: '',
      metadata: {
        status: 'error',
        stderr: err instanceof AppUnreachableError ? 'cloud-code app unreachable' : (err as Error).message,
        error: (err as Error).message,
      },
    }
  }
}

function truncateTitle(s: string): string {
  const trimmed = s.trim().replace(/\s+/g, ' ')
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed
}

async function runBrowserTool(
  client: AgentShellClient,
  procedure: string,
  args: Record<string, unknown>,
  ctx: ToolCtxLike,
  mode: 'query' | 'mutate',
): Promise<{ output: string; metadata: Record<string, unknown> }> {
  try {
    const input = { ...args, opencodeSessionId: ctx.sessionID }
    const result = mode === 'query'
      ? await client.query<unknown>(procedure, input)
      : await client.mutate<unknown>(procedure, input)
    const metadata = {
      status: 'success',
      procedure,
      cdpId: typeof result === 'object' && result && 'cdpId' in result ? (result as { cdpId?: string }).cdpId : args.cdpId,
      browserTabId: typeof result === 'object' && result && 'browserTabId' in result ? (result as { browserTabId?: string }).browserTabId : undefined,
    }
    ctx.metadata({ title: truncateTitle(procedure.replace('agentBrowser.', 'browser ')), metadata })
    return { output: browserOutput(result), metadata }
  } catch (err) {
    return {
      output: '',
      metadata: {
        status: 'error',
        procedure,
        cdpId: args.cdpId,
        stderr: err instanceof AppUnreachableError ? 'cloud-code app unreachable' : (err as Error).message,
        error: (err as Error).message,
      },
    }
  }
}

function browserOutput(result: unknown): string {
  if (typeof result === 'object' && result && 'text' in result && typeof (result as { text?: unknown }).text === 'string') {
    return (result as { text: string }).text
  }
  return JSON.stringify(result, null, 2)
}

function stripEmptyStrings<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== '')) as T
}

function normalizeInteractArgs<T extends Record<string, unknown>>(input: T): T {
  const next = stripEmptyStrings(input)
  const rawAction = next.action
  if (!rawAction || typeof rawAction !== 'object') return next
  const action = stripEmptyStrings({ ...(rawAction as Record<string, unknown>) })
  const id = action.elementId ?? action.id
  if ((action.type === 'click' || action.type === 'type') && id !== undefined) action.elementId = String(id)
  if (action.type === 'type' && action.text === undefined && action.value !== undefined) action.text = String(action.value)
  if (action.type === 'fill') {
    if (!Array.isArray(action.fields) && id !== undefined) {
      action.fields = [{ elementId: String(id), text: String(action.text ?? action.value ?? ''), clear: action.clear }]
    } else if (Array.isArray(action.fields)) {
      action.fields = action.fields.map((field) => {
        if (!field || typeof field !== 'object') return field
        const normalized = stripEmptyStrings({ ...(field as Record<string, unknown>) })
        const fieldId = normalized.elementId ?? normalized.id
        if (fieldId !== undefined) normalized.elementId = String(fieldId)
        if (normalized.text === undefined && normalized.value !== undefined) normalized.text = String(normalized.value)
        return normalized
      })
    }
  }
  const normalizedNext = next as Record<string, unknown>
  if (normalizedNext.postSnapshot && typeof normalizedNext.postSnapshot === 'object') {
    normalizedNext.postSnapshot = stripEmptyStrings({ ...(normalizedNext.postSnapshot as Record<string, unknown>) })
  }
  return { ...next, action } as T
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
