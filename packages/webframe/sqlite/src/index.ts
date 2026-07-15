import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { HistoryEntry, HistoryStore, TabRecord, TabStore } from '../../dist';

const HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS history (
  id TEXT PRIMARY KEY,
  tabId TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  visitedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_tabId ON history(tabId);
CREATE INDEX IF NOT EXISTS idx_history_visitedAt ON history(visitedAt);
`;

const TABS_SCHEMA = `
CREATE TABLE IF NOT EXISTS tabs (
  id TEXT PRIMARY KEY,
  ownerKey TEXT,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  favicon TEXT,
  createdAt INTEGER NOT NULL,
  lastVisitedAt INTEGER NOT NULL,
  stateStoreKey TEXT
);
`;

function ensureColumn(db: DatabaseType, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

function openDb(dbPath: string): DatabaseType {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function createSqliteHistoryStore(opts: { dbPath: string }): HistoryStore {
  const db = openDb(opts.dbPath);
  db.exec(HISTORY_SCHEMA);

  const insert = db.prepare<HistoryEntry>(
    `INSERT OR REPLACE INTO history (id, tabId, url, title, visitedAt)
     VALUES (@id, @tabId, @url, @title, @visitedAt)`,
  );
  const deleteByIds = db.prepare<string>(`DELETE FROM history WHERE id = ?`);
  const deleteByTab = db.prepare<string>(`DELETE FROM history WHERE tabId = ?`);

  return {
    async append(entry) {
      insert.run(entry);
    },
    async query(q) {
      const clauses: string[] = [];
      const params: Record<string, unknown> = {};
      if (q.tabId !== undefined) {
        clauses.push('tabId = @tabId');
        params.tabId = q.tabId;
      }
      if (q.since !== undefined) {
        clauses.push('visitedAt >= @since');
        params.since = q.since;
      }
      if (q.search) {
        clauses.push('(url LIKE @search OR title LIKE @search)');
        params.search = `%${q.search}%`;
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = q.limit !== undefined ? `LIMIT @limit` : '';
      if (q.limit !== undefined) params.limit = q.limit;
      const sql = `SELECT id, tabId, url, title, visitedAt FROM history ${where} ORDER BY visitedAt ASC ${limit}`;
      const stmt = db.prepare(sql);
      return stmt.all(params) as HistoryEntry[];
    },
    async delete(ids) {
      const tx = db.transaction((rows: string[]) => {
        for (const id of rows) deleteByIds.run(id);
      });
      tx(ids);
    },
    async deleteFor(tabId) {
      deleteByTab.run(tabId);
    },
  };
}

export function createSqliteTabStore(opts: { dbPath: string }): TabStore {
  const db = openDb(opts.dbPath);
  db.exec(TABS_SCHEMA);
  ensureColumn(db, 'tabs', 'ownerKey', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tabs_ownerKey ON tabs(ownerKey) WHERE ownerKey IS NOT NULL');

  const put = db.prepare<TabRecord>(
    `INSERT OR REPLACE INTO tabs
       (id, ownerKey, url, title, favicon, createdAt, lastVisitedAt, stateStoreKey)
     VALUES
       (@id, @ownerKey, @url, @title, @favicon, @createdAt, @lastVisitedAt, @stateStoreKey)`,
  );
  const getOne = db.prepare<string>(`SELECT * FROM tabs WHERE id = ?`);
  const listAll = db.prepare(`SELECT * FROM tabs ORDER BY lastVisitedAt DESC`);
  const del = db.prepare<string>(`DELETE FROM tabs WHERE id = ?`);

  const normalize = (row: Record<string, unknown> | undefined): TabRecord | undefined => {
    if (!row) return undefined;
    return {
      id: row.id as string,
      ownerKey: (row.ownerKey as string | null) ?? undefined,
      url: row.url as string,
      title: row.title as string,
      favicon: (row.favicon as string | null) ?? undefined,
      createdAt: row.createdAt as number,
      lastVisitedAt: row.lastVisitedAt as number,
      stateStoreKey: (row.stateStoreKey as string | null) ?? undefined,
    };
  };

  return {
    async put(tab) {
      put.run({
        ...tab,
        ownerKey: tab.ownerKey ?? null,
        favicon: tab.favicon ?? null,
        stateStoreKey: tab.stateStoreKey ?? null,
      } as unknown as TabRecord);
    },
    async get(id) {
      return normalize(getOne.get(id) as Record<string, unknown> | undefined);
    },
    async list() {
      const rows = listAll.all() as Record<string, unknown>[];
      return rows.map((r) => normalize(r)!).filter(Boolean);
    },
    async delete(id) {
      del.run(id);
    },
  };
}
