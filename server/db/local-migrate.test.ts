import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { localAppTables, runLocalAppMigrations } from './local-migrate'

describe('runLocalAppMigrations', () => {
  it('creates the local app SQLite schema', () => {
    const sqlitePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-app-sqlite-test-')), 'app.db')

    const result = runLocalAppMigrations(sqlitePath)

    expect(result).toEqual({
      sqlitePath,
        applied: ['0001_local_app_schema', '0002_normalized_workspace_state', '0003_workspace_agent_tabs', '0004_workspace_folders', '0005_agent_notifications', '0006_agent_notification_titles', '0007_agent_notification_kinds', '0008_workspace_resources', '0009_workspace_tab_title_source', '0010_favicon_cache'],
    })
    const sqlite = new Database(sqlitePath, { readonly: true })
    try {
      const rows = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
      const tableNames = new Set(rows.map((row) => row.name))
      for (const table of localAppTables) expect(tableNames.has(table)).toBe(true)
    } finally {
      sqlite.close()
    }
  })

  it('is idempotent', () => {
    const sqlitePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-app-sqlite-test-')), 'app.db')

    runLocalAppMigrations(sqlitePath)
    const result = runLocalAppMigrations(sqlitePath)

    expect(result).toEqual({ sqlitePath, applied: [] })
  })

  it('migrates legacy workspace UI JSON into normalized tables', () => {
    const sqlitePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-app-sqlite-test-')), 'app.db')
    const sqlite = new Database(sqlitePath)
    try {
      sqlite.exec(`
        CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, run_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000));
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          last_opened_at INTEGER,
          archived_at INTEGER
        );
        CREATE TABLE workspace_ui_states (
          workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
          state TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        );
      `)
      sqlite.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run('0001_local_app_schema')
      sqlite.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run('workspace-1', 'Workspace')
      sqlite.prepare('INSERT INTO workspace_ui_states (workspace_id, state, updated_at) VALUES (?, ?, ?)').run(
        'workspace-1',
        JSON.stringify({
          activeAgentSessionId: 'agent-1',
          activeWorkspaceTabId: 'tab-1',
          splitRatio: 0.42,
          agentCollapsed: true,
          workspaceTabs: [
            { id: 'tab-1', type: 'browser', url: 'https://example.com', browserTabId: 'browser-1', title: 'Example' },
          ],
        }),
        1234,
      )
    } finally {
      sqlite.close()
    }

    const result = runLocalAppMigrations(sqlitePath)

    expect(result).toEqual({ sqlitePath, applied: ['0002_normalized_workspace_state', '0003_workspace_agent_tabs', '0004_workspace_folders', '0005_agent_notifications', '0006_agent_notification_titles', '0007_agent_notification_kinds', '0008_workspace_resources', '0009_workspace_tab_title_source', '0010_favicon_cache'] })
    const migrated = new Database(sqlitePath, { readonly: true })
    try {
      expect(migrated.prepare('SELECT * FROM workspace_view_states').get()).toMatchObject({
        workspace_id: 'workspace-1',
        active_agent_session_id: 'agent-1',
        active_workspace_tab_id: 'tab-1',
        split_ratio: 0.42,
        agent_collapsed: 1,
        updated_at: 1234,
      })
      expect(migrated.prepare('SELECT * FROM workspace_tabs').get()).toMatchObject({
        workspace_id: 'workspace-1',
        id: 'tab-1',
        type: 'browser',
        title: 'Example',
        title_source: null,
        position: 0,
        url: 'https://example.com',
        browser_tab_id: 'browser-1',
        updated_at: 1234,
      })
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_agent_tabs'").get()).toBeTruthy()
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_folders'").get()).toBeTruthy()
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_notifications'").get()).toBeTruthy()
      expect(migrated.prepare('PRAGMA table_info(agent_notifications)').all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'title' }), expect.objectContaining({ name: 'kind' })]),
      )
    } finally {
      migrated.close()
    }
  })

  it('adds workspace folder placement columns and backfills stable workspace positions', () => {
    const sqlitePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-app-sqlite-test-')), 'app.db')
    const sqlite = new Database(sqlitePath)
    try {
      sqlite.exec(`
        CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, run_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000));
        CREATE TABLE workspaces (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          last_opened_at INTEGER,
          archived_at INTEGER
        );
      `)
      sqlite.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run('0001_local_app_schema')
      sqlite.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run('0002_normalized_workspace_state')
      sqlite.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run('0003_workspace_agent_tabs')
      sqlite.prepare('INSERT INTO workspaces (id, name, created_at, updated_at, last_opened_at) VALUES (?, ?, ?, ?, ?)').run('b', 'Second', 20, 20, 100)
      sqlite.prepare('INSERT INTO workspaces (id, name, created_at, updated_at, last_opened_at) VALUES (?, ?, ?, ?, ?)').run('a', 'First', 30, 30, 100)
      sqlite.prepare('INSERT INTO workspaces (id, name, created_at, updated_at, last_opened_at) VALUES (?, ?, ?, ?, ?)').run('c', 'Third', 10, 10, null)
    } finally {
      sqlite.close()
    }

    const result = runLocalAppMigrations(sqlitePath)

    expect(result).toEqual({ sqlitePath, applied: ['0004_workspace_folders', '0005_agent_notifications', '0006_agent_notification_titles', '0007_agent_notification_kinds', '0008_workspace_resources', '0009_workspace_tab_title_source', '0010_favicon_cache'] })
    const migrated = new Database(sqlitePath, { readonly: true })
    try {
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace_folders'").get()).toBeTruthy()
      expect(migrated.prepare('PRAGMA table_info(workspaces)').all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'folder_id' }),
          expect.objectContaining({ name: 'position' }),
          expect.objectContaining({ name: 'name_source' }),
          expect.objectContaining({ name: 'source_kind' }),
          expect.objectContaining({ name: 'source_path' }),
        ]),
      )
      expect(migrated.prepare('SELECT id, folder_id, position, name_source FROM workspaces ORDER BY position ASC').all()).toEqual([
        { id: 'a', folder_id: null, position: 0, name_source: 'explicit' },
        { id: 'b', folder_id: null, position: 1, name_source: 'explicit' },
        { id: 'c', folder_id: null, position: 2, name_source: 'explicit' },
      ])
    } finally {
      migrated.close()
    }
  })
})
