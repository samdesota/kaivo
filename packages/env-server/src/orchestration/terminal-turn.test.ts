import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_RETURN_SUMMARY_MAX_CHARS } from './contracts.js'
import { terminalReturnFromMessage } from './terminal-turn.js'

function message(info: Record<string, unknown>, parts: Array<Record<string, unknown>> = []) {
  return { info: { role: 'assistant', id: 'assistant-1', ...info }, parts }
}

describe('terminal orchestration turns', () => {
  it('recognizes completed text, textless tools, and terminal errors', () => {
    expect(terminalReturnFromMessage(message({ time: { completed: 1 } }, [{ type: 'text', text: '  Result\n ready  ' }])))
      .toMatchObject({ kind: 'response', summary: 'Result ready' })
    expect(terminalReturnFromMessage(message({ finish: 'tool-calls' }, [{ type: 'tool', tool: 'bash', state: { status: 'completed' } }])))
      .toMatchObject({ kind: 'response', summary: 'Completed tool turn: bash (completed)' })
    expect(terminalReturnFromMessage(message({ error: { name: 'ProviderError', data: { message: 'rate limited' } } })))
      .toMatchObject({ kind: 'error', summary: 'rate limited' })
  })

  it('excludes pending attention, incomplete messages, and user aborts', () => {
    expect(terminalReturnFromMessage(message({}, [{ type: 'tool', tool: 'question', state: { status: 'pending' } }]))).toBeNull()
    expect(terminalReturnFromMessage(message({ error: { name: 'MessageAbortedError', message: 'aborted by user' } }))).toBeNull()
    expect(terminalReturnFromMessage({ info: { role: 'user', id: 'user-1', time: { completed: 1 } }, parts: [] })).toBeNull()
  })

  it('bounds summaries deterministically', () => {
    const result = terminalReturnFromMessage(message({ time: { completed: 1 } }, [{ type: 'text', text: 'x'.repeat(2_000) }]))
    expect(result?.summary).toHaveLength(ORCHESTRATION_RETURN_SUMMARY_MAX_CHARS)
    expect(result?.summary.endsWith('…')).toBe(true)
  })
})
