import { ORCHESTRATION_RETURN_SUMMARY_MAX_CHARS } from './contracts.js'

export type CanonicalMessage = {
  info: Record<string, unknown>
  parts: Array<Record<string, unknown>>
}

export type TerminalReturn = {
  assistantMessageId: string
  kind: 'response' | 'error'
  summary: string
}

export function boundOrchestrationText(value: string, max = ORCHESTRATION_RETURN_SUMMARY_MAX_CHARS): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  const data = record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : null
  return [record.message, data?.message, record.name]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0) ?? ''
}

function isAborted(error: unknown): boolean {
  const text = errorMessage(error).toLowerCase()
  const name = error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string'
    ? String((error as { name: string }).name).toLowerCase()
    : ''
  return name.includes('abort') || text.includes('aborted by user') || text.includes('messageaborted')
}

export function terminalReturnFromMessage(message: CanonicalMessage): TerminalReturn | null {
  const info = message.info
  if (info.role !== 'assistant' || typeof info.id !== 'string' || info.id.length === 0) return null
  const time = info.time && typeof info.time === 'object' ? info.time as Record<string, unknown> : null
  const error = info.error
  if (time?.completed == null && info.finish == null && error == null) return null
  if (isAborted(error)) return null

  if (error != null) {
    const detail = errorMessage(error)
    return {
      assistantMessageId: info.id,
      kind: 'error',
      summary: boundOrchestrationText(detail || 'The agent turn ended with an error.'),
    }
  }

  const text = message.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => String(part.text))
    .join('\n')
    .trim()
  if (text) return { assistantMessageId: info.id, kind: 'response', summary: boundOrchestrationText(text) }

  const tools = message.parts
    .filter((part) => part.type === 'tool')
    .map((part) => {
      const tool = typeof part.tool === 'string' ? part.tool : 'tool'
      const state = part.state && typeof part.state === 'object'
        ? (part.state as Record<string, unknown>).status
        : undefined
      return typeof state === 'string' ? `${tool} (${state})` : tool
    })
  const summary = tools.length > 0
    ? `Completed tool turn: ${tools.join(', ')}`
    : 'Completed without a text response.'
  return { assistantMessageId: info.id, kind: 'response', summary: boundOrchestrationText(summary) }
}
