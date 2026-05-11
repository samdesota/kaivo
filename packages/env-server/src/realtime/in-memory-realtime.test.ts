import { describe, expect, it, vi } from 'vitest'
import { InMemoryRealtimeStore } from './in-memory-realtime.js'

describe('InMemoryRealtimeStore', () => {
  it('empty snapshot returns no rows and current seq', () => {
    const store = new InMemoryRealtimeStore([{ table: 'items', key: 'id' }])

    expect(store.snapshot('items')).toEqual({ table: 'items', rows: [], seq: 0 })
  })

  it('upsert emits insert, updates snapshot, and increments seq', () => {
    const store = new InMemoryRealtimeStore([{ table: 'items', key: 'id' }])
    const event = store.upsert('items', { id: 'a', value: 1 })

    expect(event).toEqual({ seq: 1, table: 'items', op: 'insert', key: 'a', row: { id: 'a', value: 1 } })
    expect(store.snapshot('items')).toEqual({ table: 'items', rows: [{ id: 'a', value: 1 }], seq: 1 })
  })

  it('updating an existing key emits update, not insert', () => {
    const store = new InMemoryRealtimeStore([{ table: 'items', key: 'id' }])
    store.upsert('items', { id: 'a', value: 1 })

    expect(store.upsert('items', { id: 'a', value: 2 })).toMatchObject({ seq: 2, op: 'update', key: 'a' })
    expect(store.snapshot('items').rows).toEqual([{ id: 'a', value: 2 }])
  })

  it('delete existing key emits delete with null row', () => {
    const store = new InMemoryRealtimeStore([{ table: 'items', key: 'id' }])
    store.upsert('items', { id: 'a', value: 1 })

    expect(store.delete('items', 'a')).toEqual({ seq: 2, table: 'items', op: 'delete', key: 'a', row: null })
    expect(store.snapshot('items').rows).toEqual([])
  })

  it('delete missing key is a no-op and emits nothing', () => {
    const store = new InMemoryRealtimeStore([{ table: 'items', key: 'id' }])
    const listener = vi.fn()
    store.subscribe(listener)

    expect(store.delete('items', 'missing')).toBeNull()
    expect(listener).not.toHaveBeenCalled()
    expect(store.snapshot('items').seq).toBe(0)
  })

  it('changes returns missed events in seq order', () => {
    const store = new InMemoryRealtimeStore([{ table: 'items', key: 'id' }])
    store.upsert('items', { id: 'a' })
    store.upsert('items', { id: 'b' })
    store.delete('items', 'a')

    expect(store.changes(1).map((event) => event.seq)).toEqual([2, 3])
  })

  it('changes filters by table', () => {
    const store = new InMemoryRealtimeStore([{ table: 'tableA', key: 'id' }, { table: 'tableB', key: 'id' }])
    store.upsert('tableA', { id: 'a' })
    store.upsert('tableB', { id: 'b' })

    expect(store.changes(0, ['tableA']).map((event) => event.table)).toEqual(['tableA'])
  })

  it('subscribe receives emitted event batches', () => {
    const store = new InMemoryRealtimeStore([{ table: 'items', key: 'id' }])
    const listener = vi.fn()
    store.subscribe(listener)

    store.upsert('items', { id: 'a' })

    expect(listener).toHaveBeenCalledWith([{ seq: 1, table: 'items', op: 'insert', key: 'a', row: { id: 'a' } }])
  })

  it('unsubscribe prevents future notifications', () => {
    const store = new InMemoryRealtimeStore([{ table: 'items', key: 'id' }])
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    unsubscribe()

    store.upsert('items', { id: 'a' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('multiple tables keep independent snapshots but share global seq', () => {
    const store = new InMemoryRealtimeStore([{ table: 'tableA', key: 'id' }, { table: 'tableB', key: 'id' }])

    store.upsert('tableA', { id: 'a' })
    store.upsert('tableB', { id: 'b' })

    expect(store.snapshot('tableA')).toEqual({ table: 'tableA', rows: [{ id: 'a' }], seq: 2 })
    expect(store.snapshot('tableB')).toEqual({ table: 'tableB', rows: [{ id: 'b' }], seq: 2 })
  })

  it('external row mutation does not mutate stored rows', () => {
    const store = new InMemoryRealtimeStore([{ table: 'items', key: 'id' }])
    const row = { id: 'a', nested: { value: 1 } }
    store.upsert('items', row)
    row.nested.value = 2
    const snapshot = store.snapshot<{ id: string; nested: { value: number } }>('items')
    snapshot.rows[0]!.nested.value = 3

    expect(store.snapshot('items').rows).toEqual([{ id: 'a', nested: { value: 1 } }])
  })
})
