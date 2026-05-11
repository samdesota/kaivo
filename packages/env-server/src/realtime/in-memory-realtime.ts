export type InMemoryRealtimeOp = 'insert' | 'update' | 'delete'

export type InMemoryRealtimeEvent<T extends object = Record<string, unknown>> = {
  seq: number
  table: string
  op: InMemoryRealtimeOp
  key: string
  row: T | null
}

export type InMemoryRealtimeSnapshot<T extends object = Record<string, unknown>> = {
  table: string
  rows: T[]
  seq: number
}

export type InMemoryRealtimeTable<T extends object = Record<string, unknown>> = {
  table: string
  key?: keyof T & string
  keyColumns?: Array<keyof T & string>
  keyFn?: (row: T) => string
}

type Listener = (events: InMemoryRealtimeEvent[]) => void

export class InMemoryRealtimeStore {
  private seq = 0
  private rows = new Map<string, Map<string, Record<string, unknown>>>()
  private events: InMemoryRealtimeEvent[] = []
  private listeners = new Set<Listener>()
  private tableByName: Map<string, InMemoryRealtimeTable>

  constructor(tables: InMemoryRealtimeTable[]) {
    this.tableByName = new Map(tables.map((table) => [table.table, table]))
    for (const table of tables) this.rows.set(table.table, new Map())
  }

  snapshot<T extends object = Record<string, unknown>>(tableName: string): InMemoryRealtimeSnapshot<T> {
    this.requireTable(tableName)
    return {
      table: tableName,
      rows: [...(this.rows.get(tableName)?.values() ?? [])].map((row) => cloneRow(row) as T),
      seq: this.seq,
    }
  }

  changes(afterSeq: number, tableNames?: string[]): InMemoryRealtimeEvent[] {
    const filter = tableNames?.length ? new Set(tableNames) : null
    if (filter) for (const table of filter) this.requireTable(table)
    return this.events
      .filter((event) => event.seq > afterSeq && (!filter || filter.has(event.table)))
      .map(cloneEvent)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  insert<T extends object>(tableName: string, row: T): InMemoryRealtimeEvent<T> {
    const table = this.requireTable(tableName)
    const key = rowKey(table, row as Record<string, unknown>)
    if (this.rows.get(tableName)?.has(key)) throw new Error(`in-memory realtime row already exists: ${tableName}:${key}`)
    return this.write(tableName, 'insert', key, row)
  }

  update<T extends object>(tableName: string, row: T): InMemoryRealtimeEvent<T> {
    const table = this.requireTable(tableName)
    const key = rowKey(table, row as Record<string, unknown>)
    if (!this.rows.get(tableName)?.has(key)) throw new Error(`in-memory realtime row does not exist: ${tableName}:${key}`)
    return this.write(tableName, 'update', key, row)
  }

  upsert<T extends object>(tableName: string, row: T): InMemoryRealtimeEvent<T> {
    const table = this.requireTable(tableName)
    const key = rowKey(table, row as Record<string, unknown>)
    const op = this.rows.get(tableName)?.has(key) ? 'update' : 'insert'
    return this.write(tableName, op, key, row)
  }

  delete(tableName: string, keyOrRow: string | Record<string, unknown>): InMemoryRealtimeEvent | null {
    const table = this.requireTable(tableName)
    const key = typeof keyOrRow === 'string' ? keyOrRow : rowKey(table, keyOrRow)
    const tableRows = this.rows.get(tableName)
    if (!tableRows?.has(key)) return null
    tableRows.delete(key)
    return this.append({ table: tableName, op: 'delete', key, row: null })
  }

  private write<T extends object>(tableName: string, op: 'insert' | 'update', key: string, row: T): InMemoryRealtimeEvent<T> {
    this.rows.get(tableName)!.set(key, cloneRow(row) as Record<string, unknown>)
    return this.append({ table: tableName, op, key, row: row as Record<string, unknown> }) as InMemoryRealtimeEvent<T>
  }

  private append(event: Omit<InMemoryRealtimeEvent, 'seq'>): InMemoryRealtimeEvent {
    const stored = cloneEvent({ ...event, seq: ++this.seq })
    this.events.push(stored)
    const emitted = [cloneEvent(stored)]
    for (const listener of this.listeners) listener(emitted)
    return cloneEvent(stored)
  }

  private requireTable(tableName: string): InMemoryRealtimeTable {
    const table = this.tableByName.get(tableName)
    if (!table) throw new Error(`in-memory realtime table is not registered: ${tableName}`)
    return table
  }
}

function rowKey(table: InMemoryRealtimeTable, row: Record<string, unknown>): string {
  if (table.keyFn) return table.keyFn(row)
  if (table.key) return String(row[table.key])
  if (table.keyColumns?.length === 1) return String(row[table.keyColumns[0]!])
  if (table.keyColumns?.length) {
    return JSON.stringify(Object.fromEntries(table.keyColumns.map((column) => [column, row[column]])))
  }
  throw new Error(`${table.table} must include key, keyColumns, or keyFn`)
}

function cloneRow<T extends object>(row: T): T {
  return structuredClone(row)
}

function cloneEvent<T extends InMemoryRealtimeEvent>(event: T): T {
  return {
    ...event,
    row: event.row ? cloneRow(event.row) : null,
  }
}
