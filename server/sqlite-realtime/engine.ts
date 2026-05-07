import type Database from 'better-sqlite3'

export type SqliteRealtimeOp = 'insert' | 'update' | 'delete'

export type SqliteRealtimeColumn = {
  name: string
  jsonName?: string
}

export type SqliteRealtimeTable = {
  table: string
  keyColumns: string[]
  columns: SqliteRealtimeColumn[]
}

export type SqliteRealtimeEvent = {
  seq: number
  table: string
  op: SqliteRealtimeOp
  key: string
  row: Record<string, unknown> | null
  committedAt: number
}

export type SqliteRealtimeSnapshot<T = Record<string, unknown>> = {
  table: string
  rows: T[]
  seq: number
}

type Listener = (events: SqliteRealtimeEvent[]) => void

const LOG_TABLE = 'cc_realtime_log'
const NOTIFY_FUNCTION = 'cc_realtime_notify'
const MILLIS_EXPR = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)"

export class SqliteRealtimeEngine {
  private listeners = new Set<Listener>()
  private drainQueued = false
  private lastDrainedSeq = 0
  private closed = false
  private tableByName: Map<string, SqliteRealtimeTable>

  constructor(
    private sqlite: Database.Database,
    private tables: SqliteRealtimeTable[],
  ) {
    this.tableByName = new Map(tables.map((table) => [table.table, table]))
    this.installNotifyFunction()
    this.install()
    this.lastDrainedSeq = this.currentSeq()
  }

  install(): void {
    assertSafeIdentifier(LOG_TABLE, 'log table')
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS ${quoteIdent(LOG_TABLE)} (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
        row_key TEXT NOT NULL,
        row_json TEXT,
        committed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cc_realtime_log_seq_idx ON ${quoteIdent(LOG_TABLE)} (seq);
      CREATE INDEX IF NOT EXISTS cc_realtime_log_table_seq_idx ON ${quoteIdent(LOG_TABLE)} (table_name, seq);
    `)
    for (const table of this.tables) this.installTable(table)
  }

  snapshot<T = Record<string, unknown>>(tableName: string): SqliteRealtimeSnapshot<T> {
    const table = this.requireTable(tableName)
    const cols = table.columns.map((column) => `${quoteIdent(column.name)} AS ${quoteIdent(column.jsonName ?? column.name)}`).join(', ')
    const orderBy = table.keyColumns.map((column) => quoteIdent(column)).join(', ')
    const rows = this.sqlite.prepare(`SELECT ${cols} FROM ${quoteIdent(table.table)} ORDER BY ${orderBy}`).all() as T[]
    return { table: table.table, rows, seq: this.currentSeq() }
  }

  changes(afterSeq: number, tableNames?: string[]): SqliteRealtimeEvent[] {
    const tableFilter = tableNames?.length ? tableNames : null
    if (tableFilter) for (const table of tableFilter) this.requireTable(table)
    const params: unknown[] = [afterSeq]
    let where = 'seq > ?'
    if (tableFilter) {
      where += ` AND table_name IN (${tableFilter.map(() => '?').join(', ')})`
      params.push(...tableFilter)
    }
    return this.sqlite
      .prepare(`SELECT seq, table_name, op, row_key, row_json, committed_at FROM ${quoteIdent(LOG_TABLE)} WHERE ${where} ORDER BY seq ASC`)
      .all(...params)
      .map(rowToEvent)
  }

  subscribe(listener: Listener): () => void {
    if (this.closed) throw new Error('sqlite realtime engine is closed')
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  notify(): void {
    if (this.closed || this.drainQueued) return
    this.drainQueued = true
    queueMicrotask(() => this.drain())
  }

  drain(): void {
    this.drainQueued = false
    if (this.closed || !isDatabaseOpen(this.sqlite)) return
    const events = this.changes(this.lastDrainedSeq)
    if (events.length === 0) return
    this.lastDrainedSeq = events[events.length - 1]!.seq
    for (const listener of this.listeners) listener(events)
  }

  close(): void {
    this.closed = true
    this.listeners.clear()
  }

  private installNotifyFunction(): void {
    this.sqlite.function(NOTIFY_FUNCTION, () => {
      this.notify()
      return null
    })
  }

  private installTable(table: SqliteRealtimeTable): void {
    assertSafeIdentifier(table.table, 'table')
    if (table.keyColumns.length === 0) throw new Error(`${table.table} must include at least one key column`)
    for (const column of table.keyColumns) assertSafeIdentifier(column, `${table.table} key column`)
    if (table.columns.length === 0) throw new Error(`${table.table} must include at least one column`)
    for (const column of table.columns) {
      assertSafeIdentifier(column.name, `${table.table} column`)
      if (column.jsonName) assertSafeJsonName(column.jsonName, `${table.table} json column`)
    }

    const tableIdent = quoteIdent(table.table)
    const keyExprNew = keyExpr('NEW', table.keyColumns)
    const keyExprOld = keyExpr('OLD', table.keyColumns)
    const insertPayload = jsonObjectExpr('NEW', table.columns)
    const updatePayload = jsonObjectExpr('NEW', table.columns)
    const deletePayload = jsonObjectExpr('OLD', table.columns)
    const insertTrigger = triggerName(table.table, 'insert')
    const updateTrigger = triggerName(table.table, 'update')
    const deleteTrigger = triggerName(table.table, 'delete')

    this.sqlite.exec(`
      DROP TRIGGER IF EXISTS ${quoteIdent(insertTrigger)};
      DROP TRIGGER IF EXISTS ${quoteIdent(updateTrigger)};
      DROP TRIGGER IF EXISTS ${quoteIdent(deleteTrigger)};

      CREATE TRIGGER ${quoteIdent(insertTrigger)}
      AFTER INSERT ON ${tableIdent}
      BEGIN
        INSERT INTO ${quoteIdent(LOG_TABLE)} (table_name, op, row_key, row_json, committed_at)
        VALUES (${sqlString(table.table)}, 'insert', ${keyExprNew}, ${insertPayload}, ${MILLIS_EXPR});
        SELECT ${NOTIFY_FUNCTION}();
      END;

      CREATE TRIGGER ${quoteIdent(updateTrigger)}
      AFTER UPDATE ON ${tableIdent}
      BEGIN
        INSERT INTO ${quoteIdent(LOG_TABLE)} (table_name, op, row_key, row_json, committed_at)
        VALUES (${sqlString(table.table)}, 'update', ${keyExprNew}, ${updatePayload}, ${MILLIS_EXPR});
        SELECT ${NOTIFY_FUNCTION}();
      END;

      CREATE TRIGGER ${quoteIdent(deleteTrigger)}
      AFTER DELETE ON ${tableIdent}
      BEGIN
        INSERT INTO ${quoteIdent(LOG_TABLE)} (table_name, op, row_key, row_json, committed_at)
        VALUES (${sqlString(table.table)}, 'delete', ${keyExprOld}, ${deletePayload}, ${MILLIS_EXPR});
        SELECT ${NOTIFY_FUNCTION}();
      END;
    `)
  }

  private requireTable(tableName: string): SqliteRealtimeTable {
    const table = this.tableByName.get(tableName)
    if (!table) throw new Error(`sqlite realtime table is not registered: ${tableName}`)
    return table
  }

  private currentSeq(): number {
    const row = this.sqlite.prepare(`SELECT COALESCE(MAX(seq), 0) AS seq FROM ${quoteIdent(LOG_TABLE)}`).get() as { seq: number }
    return row.seq
  }
}

function rowToEvent(row: unknown): SqliteRealtimeEvent {
  const r = row as { seq: number; table_name: string; op: SqliteRealtimeOp; row_key: string; row_json: string | null; committed_at: number }
  return {
    seq: r.seq,
    table: r.table_name,
    op: r.op,
    key: r.row_key,
    row: r.row_json ? JSON.parse(r.row_json) as Record<string, unknown> : null,
    committedAt: r.committed_at,
  }
}

function isDatabaseOpen(sqlite: Database.Database): boolean {
  return (sqlite as unknown as { open?: boolean }).open !== false
}

function jsonObjectExpr(rowAlias: 'NEW' | 'OLD', columns: SqliteRealtimeColumn[]): string {
  return `json_object(${columns.map((column) => `${sqlString(column.jsonName ?? column.name)}, ${rowAlias}.${quoteIdent(column.name)}`).join(', ')})`
}

function keyExpr(rowAlias: 'NEW' | 'OLD', columns: string[]): string {
  if (columns.length === 1) return `CAST(${rowAlias}.${quoteIdent(columns[0]!)} AS TEXT)`
  return `json_object(${columns.map((column) => `${sqlString(column)}, ${rowAlias}.${quoteIdent(column)}`).join(', ')})`
}

function triggerName(table: string, op: SqliteRealtimeOp): string {
  return `cc_realtime_${table}_${op}`
}

function quoteIdent(identifier: string): string {
  assertSafeIdentifier(identifier, 'identifier')
  return `"${identifier.replaceAll('"', '""')}"`
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function assertSafeIdentifier(identifier: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new Error(`invalid ${label}: ${identifier}`)
}

function assertSafeJsonName(name: string, label: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid ${label}: ${name}`)
}
