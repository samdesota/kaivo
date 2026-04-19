import { describe, expect, it } from 'vitest'
import {
  applyEvent,
  emptyTranscript,
  flattenParts,
  hydrateFromMessages,
  permissionForCall,
} from '../../src/routes/sandbox/agent/transcript-store.js'

/**
 * Pure-function tests for the transcript store — exercises cold-load hydration,
 * live-event merging, out-of-order arrivals, and permission lookup. The
 * reducer backs the Phase-5 native AgentSessionView; a regression here
 * silently breaks transcript rendering.
 */

function msg(id: string, role: string, created: number) {
  return { info: { id, role, time: { created } }, parts: [] as Record<string, unknown>[] }
}
function textPart(id: string, messageID: string, text: string) {
  return { id, type: 'text', messageID, sessionID: 's', text }
}
function toolPart(id: string, messageID: string, tool: string, callID: string, state: Record<string, unknown>) {
  return { id, type: 'tool', messageID, sessionID: 's', tool, callID, state }
}

describe('transcript-store', () => {
  it('hydrate orders messages by time.created and preserves part order within a message', () => {
    const m1 = msg('m1', 'user', 10)
    m1.parts = [textPart('p1', 'm1', 'hello')]
    const m2 = msg('m2', 'assistant', 20)
    m2.parts = [textPart('p2', 'm2', 'hi'), textPart('p3', 'm2', ' there')]
    const s = hydrateFromMessages(emptyTranscript(), [m2, m1]) // intentionally reversed
    const flat = flattenParts(s)
    expect(flat.map((p) => p.id)).toEqual(['p1', 'p2', 'p3'])
  })

  it('applyEvent merges a streaming text delta into the same part', () => {
    let s = hydrateFromMessages(emptyTranscript(), [{
      info: { id: 'm1', role: 'assistant', time: { created: 0 } },
      parts: [textPart('p1', 'm1', 'hel')],
    }])
    s = applyEvent(s, {
      type: 'message.part.updated',
      payload: { part: textPart('p1', 'm1', 'hello world') },
    })
    const p = flattenParts(s)[0] as { text?: string }
    expect(p.text).toBe('hello world')
  })

  it('accepts a part whose message has not been announced yet (out-of-order arrival)', () => {
    let s = emptyTranscript()
    s = applyEvent(s, {
      type: 'message.part.updated',
      payload: { part: textPart('p1', 'm1', 'orphaned') },
    })
    expect(flattenParts(s)).toHaveLength(1)
    // Message is stubbed; later message.updated fills it in.
    s = applyEvent(s, {
      type: 'message.updated',
      payload: { info: { id: 'm1', role: 'assistant', time: { created: 5 } } },
    })
    expect(s.messages.get('m1')?.role).toBe('assistant')
  })

  it('permission.updated + permission.replied track pending approvals by callID', () => {
    let s = emptyTranscript()
    // OpenCode's Permission has callID as a top-level field.
    s = applyEvent(s, {
      type: 'permission.updated',
      payload: {
        id: 'perm-1',
        sessionID: 's',
        title: 'Run bash?',
        callID: 'call-xyz',
        metadata: {},
        time: { created: 1 },
      },
    })
    expect(permissionForCall(s, 'call-xyz')?.id).toBe('perm-1')
    s = applyEvent(s, { type: 'permission.replied', payload: { permissionID: 'perm-1' } })
    expect(permissionForCall(s, 'call-xyz')).toBeUndefined()
  })

  it('permission.updated: falls back to metadata.callID for older payloads', () => {
    const s = applyEvent(emptyTranscript(), {
      type: 'permission.updated',
      payload: {
        id: 'perm-2',
        sessionID: 's',
        title: 'x',
        metadata: { callID: 'legacy-call' },
        time: { created: 1 },
      },
    })
    expect(permissionForCall(s, 'legacy-call')?.id).toBe('perm-2')
  })

  it('tool-part status transitions are preserved on update', () => {
    let s = emptyTranscript()
    s = applyEvent(s, {
      type: 'message.part.updated',
      payload: {
        part: toolPart('p1', 'm1', 'cloud_bash', 'c1', { status: 'running', input: { command: 'ls' } }),
      },
    })
    s = applyEvent(s, {
      type: 'message.part.updated',
      payload: {
        part: toolPart('p1', 'm1', 'cloud_bash', 'c1', {
          status: 'completed',
          input: { command: 'ls' },
          output: 'a\nb\n',
          metadata: { cloudcode_shell_id: 'sh-1', cloudcode_exit_code: 0 },
          time: { start: 0, end: 1200 },
        }),
      },
    })
    const p = flattenParts(s)[0] as { state?: { status?: string; output?: string } }
    expect(p.state?.status).toBe('completed')
    expect(p.state?.output).toBe('a\nb\n')
  })

  it('hydrate + live events produce the same shape regardless of order', () => {
    const evt1 = {
      type: 'message.updated',
      payload: { info: { id: 'm1', role: 'assistant', time: { created: 1 } } },
    }
    const evt2 = { type: 'message.part.updated', payload: { part: textPart('p1', 'm1', 'yo') } }
    let a = emptyTranscript()
    a = applyEvent(a, evt1)
    a = applyEvent(a, evt2)
    let b = emptyTranscript()
    b = applyEvent(b, evt2)
    b = applyEvent(b, evt1)
    expect(flattenParts(a).map((p) => p.id)).toEqual(flattenParts(b).map((p) => p.id))
  })

  it('ignores unknown event types', () => {
    const s = applyEvent(emptyTranscript(), { type: 'mystery.event', payload: {} })
    expect(flattenParts(s)).toHaveLength(0)
    expect(s.permissions.size).toBe(0)
  })
})
