import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import { opencodeBasicAuthHeader, opencodeSupervisor, type OpenCodeEndpoint } from '../agent/opencode.js'
import type { WalkthroughMessage, WalkthroughModelRunInput, WalkthroughModelRunner, WalkthroughModelStreamEvent } from './model-runner.js'

const KNOWN_TOOLS = [
  'bash', 'pty', 'read', 'write', 'edit', 'glob', 'grep', 'list', 'task', 'todowrite',
  'webfetch', 'websearch', 'question', 'skill', 'apply_patch', 'kaivo_bash', 'kaivo_pty',
  'kaivo_pty_list', 'kaivo_pty_write', 'kaivo_pty_read', 'kaivo_pty_close',
  'kaivo_open_pane', 'kaivo_dispatch_subtask', 'kaivo_report_subtask_delivery',
] as const

interface OpenCodeModelRunnerOptions {
  start?: () => Promise<OpenCodeEndpoint>
  createClient?: typeof createOpencodeClient
}

function directoryOptions(cwd: string) {
  return {
    query: { directory: cwd },
    headers: { 'x-opencode-directory': cwd },
  }
}

function promptText(messages: WalkthroughMessage[]): string {
  const conversational = messages.filter((message) => message.role !== 'system')
  if (conversational.length === 1 && conversational[0]?.role === 'user') return conversational[0].content
  return conversational.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join('\n\n')
}

function sessionErrorMessage(value: unknown): string {
  if (!value || typeof value !== 'object') return 'OpenCode model run failed'
  const error = value as { message?: unknown; data?: { message?: unknown } }
  const message = error.message ?? error.data?.message
  return typeof message === 'string' && message ? message : 'OpenCode model run failed'
}

function abortError(): Error {
  return new DOMException('Walkthrough model run aborted', 'AbortError')
}

export class OpenCodeWalkthroughModelRunner implements WalkthroughModelRunner {
  private readonly start: () => Promise<OpenCodeEndpoint>
  private readonly createClient: typeof createOpencodeClient

  constructor(options: OpenCodeModelRunnerOptions = {}) {
    this.start = options.start ?? (() => opencodeSupervisor.start())
    this.createClient = options.createClient ?? createOpencodeClient
  }

  async *run(input: WalkthroughModelRunInput): AsyncIterable<WalkthroughModelStreamEvent> {
    if (input.signal.aborted) throw abortError()
    const endpoint = await this.start()
    const client = this.createClient({
      baseUrl: `http://${endpoint.host}:${endpoint.port}`,
      headers: { authorization: opencodeBasicAuthHeader(endpoint.password) },
    })
    const dir = directoryOptions(input.cwd)
    const sessionId = input.sessionId ?? (await client.session.create({
      body: { title: 'Private code walkthrough' },
      ...dir,
      throwOnError: true,
    })).data.id
    yield { type: 'session', sessionId }

    const toolIds = await client.tool.ids({ query: { directory: input.cwd }, throwOnError: true })
    const ids = Array.isArray(toolIds.data) ? toolIds.data.filter((id): id is string => typeof id === 'string') : []
    const tools = Object.fromEntries([...new Set([...KNOWN_TOOLS, ...ids])].map((id) => [id, false]))
    const stream = await client.event.subscribe({ signal: input.signal, query: { directory: input.cwd } })
    const abortSession = () => {
      void client.session.abort({ path: { id: sessionId }, ...dir, throwOnError: true }).catch(() => undefined)
    }
    input.signal.addEventListener('abort', abortSession, { once: true })

    const systems = input.messages.filter((message) => message.role === 'system').map((message) => message.content)
    try {
      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: 'text', text: promptText(input.messages) }],
          tools,
          model: { providerID: input.model.providerID, modelID: input.model.modelID },
          ...(systems.length > 0 ? { system: systems.join('\n\n') } : {}),
          ...(input.model.variant ? { variant: input.model.variant } : {}),
        },
        ...dir,
        throwOnError: true,
      })

      const priorText = new Map<string, string>()
      const assistantMessageIds = new Set<string>()
      for await (const raw of stream.stream) {
        if (input.signal.aborted) throw abortError()
        const event = raw as { type?: string; properties?: Record<string, unknown> }
        const properties = event.properties ?? {}
        if (event.type === 'message.updated') {
          const info = properties.info as { id?: string; sessionID?: string; role?: string } | undefined
          if (info?.sessionID === sessionId && info.role === 'assistant' && info.id) assistantMessageIds.add(info.id)
          continue
        }
        if (event.type === 'message.part.updated') {
          const part = properties.part as { id?: string; messageID?: string; sessionID?: string; type?: string; text?: string; ignored?: boolean; synthetic?: boolean } | undefined
          if (part?.sessionID !== sessionId) continue
          if (!part.messageID || !assistantMessageIds.has(part.messageID)) continue
          if (part.type === 'tool') throw new Error('Walkthrough model attempted to invoke a disabled tool')
          if (part.type !== 'text' || part.ignored || part.synthetic || typeof part.text !== 'string') continue
          const explicitDelta = typeof properties.delta === 'string' ? properties.delta : null
          const previous = part.id ? priorText.get(part.id) ?? '' : ''
          const delta = explicitDelta ?? (part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text)
          if (part.id) priorText.set(part.id, part.text)
          if (delta) yield { type: 'text-delta', delta }
          continue
        }
        if (event.type === 'session.error') {
          const eventSessionId = properties.sessionID
          if (eventSessionId !== sessionId) continue
          throw new Error(sessionErrorMessage(properties.error))
        }
        if (event.type === 'session.idle' && properties.sessionID === sessionId) {
          yield { type: 'finish' }
          return
        }
      }
      if (input.signal.aborted) throw abortError()
      throw new Error('OpenCode event stream ended before the walkthrough finished')
    } finally {
      input.signal.removeEventListener('abort', abortSession)
    }
  }
}

export const openCodeWalkthroughModelRunner = new OpenCodeWalkthroughModelRunner()
