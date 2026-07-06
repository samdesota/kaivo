import { describe, expect, it } from 'vitest'
import { emptyTranscript, hydrateTranscriptProjection } from '../../src/routes/env/agent/transcript-store'

describe('hydrateTranscriptProjection', () => {
  it('merges OpenCode messages and overlay session errors without duplicating after reconnect', () => {
    const overlay = {
      seq: 5,
      type: 'session.error',
      payload: { sessionID: 'oc1', message: 'persisted failure', time: { created: 5 } },
    }
    const messages = [
      {
        info: { id: 'm1', role: 'assistant', sessionID: 'oc1', time: { created: 1 } },
        parts: [{ id: 'p1', type: 'text', messageID: 'm1', sessionID: 'oc1', text: 'hello' }],
      },
    ]

    const first = hydrateTranscriptProjection({ messages, children: [], overlays: [overlay] })
    const second = hydrateTranscriptProjection({ state: first, messages, children: [], overlays: [overlay] })

    expect(second.parts.get('p1')?.text).toBe('hello')
    const errors = [...second.parts.values()].filter((part) => part.type === 'session-error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe('persisted failure')
  })

  it('tolerates legacy replay rows containing message and part events', () => {
    const projected = hydrateTranscriptProjection({
      state: emptyTranscript(),
      messages: [],
      children: [],
      overlays: [
        {
          seq: 1,
          type: 'message.updated',
          payload: { info: { id: 'legacy-message', role: 'assistant', time: { created: 1 } } },
        },
        {
          seq: 2,
          type: 'message.part.updated',
          payload: { part: { id: 'legacy-part', type: 'text', messageID: 'legacy-message', text: 'legacy persisted text' } },
        },
      ],
    })

    expect(projected.messages.has('legacy-message')).toBe(true)
    expect(projected.parts.get('legacy-part')?.text).toBe('legacy persisted text')
  })
})
