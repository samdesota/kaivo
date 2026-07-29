import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  start: vi.fn(), snapshot: vi.fn(), events: vi.fn(), subscribe: vi.fn(), cancel: vi.fn(),
}))

vi.mock('../../envmeta/service.js', () => ({
  isPaired: () => true,
  hashEnvToken: () => 'hash',
  hasEnvTokenHash: () => true,
}))
vi.mock('../../agent/opencode.js', () => ({ opencodeSupervisor: { verifyAgentShellToken: () => false } }))
vi.mock('../../config.js', () => ({ config: { CC_KIND: 'local' } }))
vi.mock('../../walkthrough/service.js', () => ({
  WalkthroughError: class WalkthroughError extends Error {
    constructor(public code: string, message: string) { super(message) }
  },
  walkthroughService: mocks,
}))

function context(authed = true) {
  return { req: { headers: {} } as never, res: {} as never, envTokenPresent: authed, agentShellTokenPresent: false }
}

beforeEach(() => vi.clearAllMocks())

describe('walkthrough router', () => {
  it('requires environment authentication', async () => {
    const { walkthroughRouter } = await import('./walkthrough.js')
    const caller = walkthroughRouter.createCaller(context(false))
    await expect(caller.snapshot({ walkthroughId: 'walkthrough-1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(mocks.snapshot).not.toHaveBeenCalled()
  })

  it('validates and forwards start, snapshot, and cancel operations', async () => {
    mocks.start.mockResolvedValue({ walkthroughId: 'walkthrough-1' })
    mocks.snapshot.mockReturnValue({ id: 'walkthrough-1' })
    const { walkthroughRouter } = await import('./walkthrough.js')
    const caller = walkthroughRouter.createCaller(context())
    const input = {
      requestKey: 'request-1', cwd: '/repo',
      comparison: { kind: 'branch' as const, originBranch: null, includeUncommitted: true },
    }

    await expect(caller.start(input)).resolves.toEqual({ walkthroughId: 'walkthrough-1' })
    await expect(caller.snapshot({ walkthroughId: 'walkthrough-1' })).resolves.toEqual({ id: 'walkthrough-1' })
    await expect(caller.cancel({ walkthroughId: 'walkthrough-1' })).resolves.toEqual({ ok: true })
    expect(mocks.start).toHaveBeenCalledWith(input)
    expect(mocks.cancel).toHaveBeenCalledWith('walkthrough-1')
  })

  it('rejects malformed comparison inputs before starting', async () => {
    const { walkthroughRouter } = await import('./walkthrough.js')
    const caller = walkthroughRouter.createCaller(context())
    await expect(caller.start({
      requestKey: 'request-1', cwd: '/repo',
      comparison: { kind: 'branch', originBranch: '', includeUncommitted: true },
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('buffers an event inserted between listener registration and replay without duplicating it', async () => {
    const between = { id: 'event-3', walkthroughId: 'walkthrough-1', sequence: 3, type: 'markdown.appended', data: { markdown: 'live' }, createdAt: 'now' }
    let listener: ((event: typeof between) => void) | undefined
    mocks.subscribe.mockImplementation((_id, next) => {
      listener = next
      return vi.fn()
    })
    mocks.events.mockImplementation(() => {
      listener?.(between)
      return [
        { id: 'event-2', walkthroughId: 'walkthrough-1', sequence: 2, type: 'status.changed', data: { status: 'streaming' }, createdAt: 'now' },
        between,
      ]
    })
    const { walkthroughRouter } = await import('./walkthrough.js')
    const caller = walkthroughRouter.createCaller(context())
    const observable = await caller.events({ walkthroughId: 'walkthrough-1', afterSeq: 1 })
    const received: number[] = []
    const subscription = observable.subscribe({ next: (event) => received.push(event.sequence) })

    expect(received).toEqual([2, 3])
    subscription.unsubscribe()
  })
})
