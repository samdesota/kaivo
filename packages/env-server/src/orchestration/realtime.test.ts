import { describe, expect, it } from 'vitest'
import { OrchestrationReplayBroker } from './realtime-store.js'

describe('orchestration realtime', () => {
  it('replays workspace sequences, isolates workspaces, and marks stale generations', () => {
    const realtime = new OrchestrationReplayBroker()
    const initial = realtime.cursor('workspace-1')
    realtime.publish('workspace-2')
    realtime.publish('workspace-1')
    realtime.publish('workspace-1')
    expect(realtime.changes('workspace-1', initial).map((change) => change.cursor.seq)).toEqual([1, 2])
    expect(realtime.changes('workspace-2', initial).map((change) => change.cursor.seq)).toEqual([1])
    expect(realtime.changes('workspace-1', { generation: 'old-process', seq: 99 }))
      .toEqual([{ type: 'stale', cursor: realtime.cursor('workspace-1') }])
  })

  it('requires snapshot replacement when bounded replay history is exhausted', () => {
    const realtime = new OrchestrationReplayBroker()
    const initial = realtime.cursor('workspace-1')
    for (let index = 0; index < 300; index++) realtime.publish('workspace-1')
    expect(realtime.changes('workspace-1', initial)).toEqual([
      { type: 'stale', cursor: realtime.cursor('workspace-1') },
    ])
  })
})
