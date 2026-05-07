import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { SqliteRealtimeEngine, type SqliteRealtimeEvent } from './engine'

function tempDb(): Database.Database {
  const sqlitePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sqlite-realtime-test-')), 'test.db')
  const sqlite = new Database(sqlitePath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  return sqlite
}

function setupEngine(sqlite: Database.Database): SqliteRealtimeEngine {
  sqlite.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER
    );
    CREATE TABLE workspace_tabs (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      title TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
  `)
  return new SqliteRealtimeEngine(sqlite, [
    {
      table: 'workspaces',
      keyColumns: ['id'],
      columns: [
        { name: 'id' },
        { name: 'name' },
        { name: 'position' },
        { name: 'archived_at', jsonName: 'archivedAt' },
      ],
    },
    {
      table: 'workspace_tabs',
      keyColumns: ['workspace_id', 'id'],
      columns: [
        { name: 'workspace_id', jsonName: 'workspaceId' },
        { name: 'id' },
        { name: 'title' },
        { name: 'position' },
      ],
    },
  ])
}

describe('SqliteRealtimeEngine', () => {
  it('installs durable triggers and records insert update delete events', () => {
    const sqlite = tempDb()
    try {
      const engine = setupEngine(sqlite)

      sqlite.prepare('INSERT INTO workspaces (id, name, position) VALUES (?, ?, ?)').run('w1', 'One', 1)
      sqlite.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run('Renamed', 'w1')
      sqlite.prepare('DELETE FROM workspaces WHERE id = ?').run('w1')

      expect(engine.changes(0).map(({ op, key, row }) => ({ op, key, row }))).toEqual([
        { op: 'insert', key: 'w1', row: { id: 'w1', name: 'One', position: 1, archivedAt: null } },
        { op: 'update', key: 'w1', row: { id: 'w1', name: 'Renamed', position: 1, archivedAt: null } },
        { op: 'delete', key: 'w1', row: { id: 'w1', name: 'Renamed', position: 1, archivedAt: null } },
      ])
    } finally {
      sqlite.close()
    }
  })

  it('returns snapshots with the current log sequence', () => {
    const sqlite = tempDb()
    try {
      const engine = setupEngine(sqlite)
      sqlite.prepare('INSERT INTO workspaces (id, name, position) VALUES (?, ?, ?)').run('w1', 'One', 1)
      sqlite.prepare('INSERT INTO workspaces (id, name, position) VALUES (?, ?, ?)').run('w2', 'Two', 2)

      const snapshot = engine.snapshot('workspaces')

      expect(snapshot.table).toBe('workspaces')
      expect(snapshot.seq).toBe(2)
      expect(snapshot.rows).toEqual([
        { id: 'w1', name: 'One', position: 1, archivedAt: null },
        { id: 'w2', name: 'Two', position: 2, archivedAt: null },
      ])
    } finally {
      sqlite.close()
    }
  })

  it('filters changes by sequence and table', () => {
    const sqlite = tempDb()
    try {
      const engine = setupEngine(sqlite)
      sqlite.prepare('INSERT INTO workspaces (id, name, position) VALUES (?, ?, ?)').run('w1', 'One', 1)
      const afterFirst = engine.changes(0)[0]!.seq
      sqlite.prepare('INSERT INTO workspace_tabs (workspace_id, id, title, position) VALUES (?, ?, ?, ?)').run('w1', 'tab1', 'Tab', 0)
      sqlite.prepare('UPDATE workspaces SET position = ? WHERE id = ?').run(3, 'w1')

      expect(engine.changes(afterFirst, ['workspace_tabs']).map((event) => event.table)).toEqual(['workspace_tabs'])
      expect(engine.changes(afterFirst).map((event) => event.op)).toEqual(['insert', 'update'])
    } finally {
      sqlite.close()
    }
  })

  it('does not expose rolled-back transaction changes', () => {
    const sqlite = tempDb()
    try {
      const engine = setupEngine(sqlite)
      expect(() => {
        sqlite.transaction(() => {
          sqlite.prepare('INSERT INTO workspaces (id, name, position) VALUES (?, ?, ?)').run('w1', 'One', 1)
          throw new Error('rollback')
        })()
      }).toThrow('rollback')

      expect(engine.changes(0)).toEqual([])
    } finally {
      sqlite.close()
    }
  })

  it('notifies subscribers from durable log drains', () => {
    const sqlite = tempDb()
    try {
      const engine = setupEngine(sqlite)
      const batches: SqliteRealtimeEvent[][] = []
      const unsubscribe = engine.subscribe((events) => batches.push(events))

      sqlite.prepare('INSERT INTO workspaces (id, name, position) VALUES (?, ?, ?)').run('w1', 'One', 1)
      sqlite.prepare('INSERT INTO workspaces (id, name, position) VALUES (?, ?, ?)').run('w2', 'Two', 2)
      engine.drain()
      unsubscribe()
      sqlite.prepare('INSERT INTO workspaces (id, name, position) VALUES (?, ?, ?)').run('w3', 'Three', 3)
      engine.drain()

      expect(batches).toHaveLength(1)
      expect(batches[0]!.map((event) => event.key)).toEqual(['w1', 'w2'])
    } finally {
      sqlite.close()
    }
  })

  it('automatically notifies subscribers from SQLite triggers', async () => {
    const sqlite = tempDb()
    try {
      const engine = setupEngine(sqlite)
      const batches: SqliteRealtimeEvent[][] = []
      engine.subscribe((events) => batches.push(events))

      sqlite.prepare('INSERT INTO workspaces (id, name, position) VALUES (?, ?, ?)').run('w1', 'One', 1)
      sqlite.prepare('INSERT INTO workspaces (id, name, position) VALUES (?, ?, ?)').run('w2', 'Two', 2)
      await Promise.resolve()

      expect(batches).toHaveLength(1)
      expect(batches[0]!.map((event) => event.key)).toEqual(['w1', 'w2'])
    } finally {
      sqlite.close()
    }
  })

  it('uses JSON row keys for composite keys', () => {
    const sqlite = tempDb()
    try {
      const engine = setupEngine(sqlite)
      sqlite.prepare('INSERT INTO workspace_tabs (workspace_id, id, title, position) VALUES (?, ?, ?, ?)').run('w1', 'tab1', 'Tab', 0)

      expect(engine.changes(0)[0]).toMatchObject({
        table: 'workspace_tabs',
        key: JSON.stringify({ workspace_id: 'w1', id: 'tab1' }),
      })
    } finally {
      sqlite.close()
    }
  })

  it('can resume from a prior snapshot sequence', () => {
    const sqlite = tempDb()
    try {
      const engine = setupEngine(sqlite)
      sqlite.prepare('INSERT INTO workspaces (id, name, position) VALUES (?, ?, ?)').run('w1', 'One', 1)
      const snapshot = engine.snapshot('workspaces')
      sqlite.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run('After Snapshot', 'w1')

      expect(engine.changes(snapshot.seq).map((event) => ({ op: event.op, row: event.row }))).toEqual([
        { op: 'update', row: { id: 'w1', name: 'After Snapshot', position: 1, archivedAt: null } },
      ])
    } finally {
      sqlite.close()
    }
  })

  it('rejects unsafe identifiers in table configuration', () => {
    const sqlite = tempDb()
    try {
      sqlite.exec('CREATE TABLE safe_table (id TEXT PRIMARY KEY)')
      expect(() => new SqliteRealtimeEngine(sqlite, [{ table: 'safe_table; DROP TABLE safe_table', keyColumns: ['id'], columns: [{ name: 'id' }] }])).toThrow(
        'invalid table',
      )
    } finally {
      sqlite.close()
    }
  })
})
