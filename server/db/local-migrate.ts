import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'

const nowMs = "(unixepoch() * 1000)"
const realtimeNotifyFunction = 'cc_realtime_notify'

const localSchemaSql = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  run_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  last_seen INTEGER NOT NULL DEFAULT ${nowMs},
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  folder_id TEXT REFERENCES workspace_folders(id) ON DELETE SET NULL,
  position INTEGER NOT NULL DEFAULT 0,
  name_source TEXT NOT NULL DEFAULT 'explicit',
  source_kind TEXT,
  source_path TEXT,
  kind TEXT NOT NULL DEFAULT 'user',
  system_key TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  protected INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  updated_at INTEGER NOT NULL DEFAULT ${nowMs},
  last_opened_at INTEGER,
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS workspace_folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES workspace_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  collapsed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  updated_at INTEGER NOT NULL DEFAULT ${nowMs},
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS workspace_ui_states (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS workspace_view_states (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  active_agent_session_id TEXT,
  active_workspace_tab_id TEXT,
  split_ratio REAL,
  agent_collapsed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS workspace_tabs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  title_source TEXT,
  position INTEGER NOT NULL,
  env_id TEXT,
  shell_id TEXT,
  path TEXT,
  session_id TEXT,
  port INTEGER,
  url TEXT,
  browser_tab_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT ${nowMs},
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS workspace_agent_tabs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT ${nowMs},
  PRIMARY KEY (workspace_id, session_id)
);

CREATE TABLE IF NOT EXISTS workspace_resources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  shared INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  updated_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE INDEX IF NOT EXISTS workspace_resources_workspace_idx
  ON workspace_resources(workspace_id);
CREATE INDEX IF NOT EXISTS workspace_resources_resource_idx
  ON workspace_resources(type, resource_key);

CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  normalized_url TEXT NOT NULL UNIQUE,
  origin TEXT,
  favicon_data_url TEXT,
  favicon_url TEXT,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  updated_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE INDEX IF NOT EXISTS bookmarks_updated_idx
  ON bookmarks(updated_at);

CREATE TABLE IF NOT EXISTS favicon_cache (
  page_origin TEXT PRIMARY KEY,
  icon_url TEXT NOT NULL,
  data_url TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT ${nowMs},
  last_seen_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS agent_notifications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'finished',
  title TEXT NOT NULL DEFAULT 'Chat finished',
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE INDEX IF NOT EXISTS agent_notifications_workspace_created_idx
  ON agent_notifications(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS sandboxes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  container_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  opencode_port INTEGER,
  opencode_password_secret TEXT,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS github_install (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT,
  app_id TEXT NOT NULL,
  app_slug TEXT,
  org_login TEXT,
  encrypted_private_key_ref TEXT NOT NULL,
  encrypted_webhook_secret_ref TEXT,
  client_id TEXT,
  encrypted_client_secret_ref TEXT,
  connected_at INTEGER NOT NULL DEFAULT ${nowMs},
  installed_at INTEGER
);

CREATE TABLE IF NOT EXISTS repo_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  origin_url TEXT NOT NULL,
  ref TEXT,
  github_repo_id TEXT,
  github_full_name TEXT,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  updated_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS repo_config_files (
  id TEXT PRIMARY KEY,
  config_id TEXT NOT NULL REFERENCES repo_configs(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  updated_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  config_id TEXT REFERENCES repo_configs(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  origin_url TEXT NOT NULL,
  ref TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  source TEXT NOT NULL,
  github_repo_id TEXT,
  github_full_name TEXT,
  created_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  sandbox_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  progress_pct INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  updated_at INTEGER NOT NULL DEFAULT ${nowMs},
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS github_token_cache (
  installation_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shell_sessions (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  cwd TEXT NOT NULL,
  cols INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  owner_kind TEXT NOT NULL DEFAULT 'human',
  owner_session_id TEXT,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  last_activity_at INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS agent_shell_tokens (
  token_hash TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  issued_at INTEGER NOT NULL DEFAULT ${nowMs},
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes(id) ON DELETE CASCADE,
  opencode_session_id TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  selected_provider_id TEXT,
  selected_model_id TEXT,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  last_activity_at INTEGER NOT NULL DEFAULT ${nowMs},
  archived_at INTEGER
);

CREATE TABLE IF NOT EXISTS agent_transcripts (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  ts INTEGER NOT NULL DEFAULT ${nowMs}
);

CREATE TABLE IF NOT EXISTS env_auth_tokens (
  token_hash TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  source TEXT NOT NULL,
  issued_at INTEGER NOT NULL DEFAULT ${nowMs},
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS env_auth_device_requests (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  granted_token_hash TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  approved_at INTEGER
);

CREATE TABLE IF NOT EXISTS envs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,
  env_token TEXT,
  local_identity_label TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  container_id TEXT,
  identity_token_hash TEXT REFERENCES env_auth_tokens(token_hash) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT ${nowMs},
  archived_at INTEGER,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS event_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_ts INTEGER NOT NULL,
  received_at INTEGER NOT NULL DEFAULT ${nowMs},
  source TEXT NOT NULL,
  principal TEXT,
  level TEXT NOT NULL,
  msg TEXT NOT NULL,
  ctx TEXT
);
`

export type LocalAppMigrationResult = {
  sqlitePath: string
  applied: string[]
}

function tableExists(sqlite: Database.Database, table: string): boolean {
  return Boolean(sqlite.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', table))
}

function columnExists(sqlite: Database.Database, table: string, column: string): boolean {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return rows.some((row) => row.name === column)
}

function installMigrationRealtimeNotifyNoop(sqlite: Database.Database): void {
  sqlite.function(realtimeNotifyFunction, () => null)
}

function normalizeLegacyUiState(raw: unknown) {
  const state = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const workspaceTabs = Array.isArray(state.workspaceTabs) ? state.workspaceTabs : []
  const activeWorkspaceTabId = workspaceTabs.some((tab) => {
    return tab && typeof tab === 'object' && (tab as { id?: unknown }).id === state.activeWorkspaceTabId
  })
    ? state.activeWorkspaceTabId
    : ((workspaceTabs[0] as { id?: unknown } | undefined)?.id ?? null)
  return {
    activeAgentSessionId: typeof state.activeAgentSessionId === 'string' ? state.activeAgentSessionId : null,
    activeWorkspaceTabId: typeof activeWorkspaceTabId === 'string' ? activeWorkspaceTabId : null,
    splitRatio: typeof state.splitRatio === 'number' ? state.splitRatio : null,
    agentCollapsed: state.agentCollapsed === true,
    workspaceTabs,
  }
}

function migrateWorkspaceUiStateBlob(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspace_view_states (
      workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      active_agent_session_id TEXT,
      active_workspace_tab_id TEXT,
      split_ratio REAL,
      agent_collapsed INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT ${nowMs}
    );

    CREATE TABLE IF NOT EXISTS workspace_tabs (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      title_source TEXT,
      position INTEGER NOT NULL,
      env_id TEXT,
      shell_id TEXT,
      path TEXT,
      session_id TEXT,
      port INTEGER,
      url TEXT,
      browser_tab_id TEXT,
      updated_at INTEGER NOT NULL DEFAULT ${nowMs},
      PRIMARY KEY (workspace_id, id)
    );

    CREATE TABLE IF NOT EXISTS workspace_agent_tabs (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT ${nowMs},
      PRIMARY KEY (workspace_id, session_id)
    );
  `)

  if (!tableExists(sqlite, 'workspace_ui_states')) return
  const rows = sqlite.prepare('SELECT workspace_id, state, updated_at FROM workspace_ui_states').all() as Array<{
    workspace_id: string
    state: string
    updated_at: number
  }>
  const upsertView = sqlite.prepare(`
    INSERT INTO workspace_view_states (
      workspace_id, active_agent_session_id, active_workspace_tab_id, split_ratio, agent_collapsed, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      active_agent_session_id = excluded.active_agent_session_id,
      active_workspace_tab_id = excluded.active_workspace_tab_id,
      split_ratio = excluded.split_ratio,
      agent_collapsed = excluded.agent_collapsed,
      updated_at = excluded.updated_at
  `)
  const deleteTabs = sqlite.prepare('DELETE FROM workspace_tabs WHERE workspace_id = ?')
  const insertTab = sqlite.prepare(`
    INSERT INTO workspace_tabs (
      workspace_id, id, type, title, title_source, position, env_id, shell_id, path, session_id, port, url, browser_tab_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.state)
    } catch {
      parsed = null
    }
    const state = normalizeLegacyUiState(parsed)
    upsertView.run(
      row.workspace_id,
      state.activeAgentSessionId,
      state.activeWorkspaceTabId,
      state.splitRatio,
      state.agentCollapsed ? 1 : 0,
      row.updated_at,
    )
    deleteTabs.run(row.workspace_id)
    state.workspaceTabs.forEach((tab, position) => {
      if (!tab || typeof tab !== 'object') return
      const t = tab as Record<string, unknown>
      if (typeof t.id !== 'string' || typeof t.type !== 'string') return
      insertTab.run(
        row.workspace_id,
        t.id,
        t.type,
        typeof t.title === 'string' ? t.title : t.id,
        t.type === 'shell' && t.titleSource === 'explicit' ? 'explicit' : t.type === 'shell' ? 'auto' : null,
        position,
        typeof t.envId === 'string' ? t.envId : null,
        typeof t.shellId === 'string' ? t.shellId : null,
        typeof t.path === 'string' ? t.path : null,
        typeof t.sessionId === 'string' ? t.sessionId : null,
        typeof t.port === 'number' ? t.port : null,
        typeof t.url === 'string' ? t.url : null,
        typeof t.browserTabId === 'string' ? t.browserTabId : null,
        row.updated_at,
      )
    })
  }
}

function migrateWorkspaceTabTitleSource(sqlite: Database.Database) {
  if (!tableExists(sqlite, 'workspace_tabs')) migrateWorkspaceUiStateBlob(sqlite)
  if (!columnExists(sqlite, 'workspace_tabs', 'title_source')) {
    sqlite.exec('ALTER TABLE workspace_tabs ADD COLUMN title_source TEXT')
  }
  sqlite.prepare("UPDATE workspace_tabs SET title_source = 'auto' WHERE type = 'shell' AND title_source IS NULL").run()
}

function migrateWorkspaceAgentTabs(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspace_agent_tabs (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT ${nowMs},
      PRIMARY KEY (workspace_id, session_id)
    );
  `)
}

function migrateAgentNotifications(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agent_notifications (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'finished',
      title TEXT NOT NULL DEFAULT 'Chat finished',
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT ${nowMs}
    );
    CREATE INDEX IF NOT EXISTS agent_notifications_workspace_created_idx
      ON agent_notifications(workspace_id, created_at);
  `)
  if (!columnExists(sqlite, 'agent_notifications', 'title')) {
    sqlite.exec("ALTER TABLE agent_notifications ADD COLUMN title TEXT NOT NULL DEFAULT 'Chat finished'")
  }
  if (!columnExists(sqlite, 'agent_notifications', 'kind')) {
    sqlite.exec("ALTER TABLE agent_notifications ADD COLUMN kind TEXT NOT NULL DEFAULT 'finished'")
  }
}

function migrateAgentNotificationTitles(sqlite: Database.Database) {
  if (!tableExists(sqlite, 'agent_notifications')) migrateAgentNotifications(sqlite)
  if (!columnExists(sqlite, 'agent_notifications', 'title')) {
    sqlite.exec("ALTER TABLE agent_notifications ADD COLUMN title TEXT NOT NULL DEFAULT 'Chat finished'")
  }
}

function migrateAgentNotificationKinds(sqlite: Database.Database) {
  if (!tableExists(sqlite, 'agent_notifications')) migrateAgentNotifications(sqlite)
  if (!columnExists(sqlite, 'agent_notifications', 'kind')) {
    sqlite.exec("ALTER TABLE agent_notifications ADD COLUMN kind TEXT NOT NULL DEFAULT 'finished'")
  }
}

function migrateWorkspaceResources(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspace_resources (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      shared INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT ${nowMs},
      updated_at INTEGER NOT NULL DEFAULT ${nowMs}
    );
    CREATE INDEX IF NOT EXISTS workspace_resources_workspace_idx
      ON workspace_resources(workspace_id);
    CREATE INDEX IF NOT EXISTS workspace_resources_resource_idx
      ON workspace_resources(type, resource_key);
  `)
}

function migrateFaviconCache(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS favicon_cache (
      page_origin TEXT PRIMARY KEY,
      icon_url TEXT NOT NULL,
      data_url TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT ${nowMs},
      last_seen_at INTEGER NOT NULL DEFAULT ${nowMs}
    );
  `)
}

function migrateBookmarks(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      normalized_url TEXT NOT NULL UNIQUE,
      origin TEXT,
      favicon_data_url TEXT,
      favicon_url TEXT,
      created_at INTEGER NOT NULL DEFAULT ${nowMs},
      updated_at INTEGER NOT NULL DEFAULT ${nowMs}
    );
    CREATE INDEX IF NOT EXISTS bookmarks_updated_idx
      ON bookmarks(updated_at);
  `)

  if (!tableExists(sqlite, 'workspace_resources')) return
  const rows = sqlite.prepare(`
    SELECT id, data, created_at, updated_at FROM workspace_resources
    WHERE type = 'bookmark'
    ORDER BY created_at ASC, id ASC
  `).all() as Array<{ id: string; data: string; created_at: number; updated_at: number }>
  const insert = sqlite.prepare(`
    INSERT INTO bookmarks (id, title, url, normalized_url, origin, favicon_data_url, favicon_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(normalized_url) DO UPDATE SET
      title = excluded.title,
      url = excluded.url,
      origin = excluded.origin,
      favicon_data_url = excluded.favicon_data_url,
      favicon_url = excluded.favicon_url,
      updated_at = excluded.updated_at
  `)
  for (const row of rows) {
    let data: Record<string, unknown>
    try {
      const parsed = JSON.parse(row.data) as unknown
      data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    } catch {
      data = {}
    }
    const title = typeof data.title === 'string' ? data.title.trim() : ''
    const url = typeof data.url === 'string' ? data.url.trim() : ''
    const normalizedUrl = typeof data.normalizedUrl === 'string' ? data.normalizedUrl.trim() : url
    if (!title || !url || !normalizedUrl) continue
    insert.run(
      row.id,
      title,
      url,
      normalizedUrl,
      typeof data.origin === 'string' ? data.origin : null,
      typeof data.faviconDataUrl === 'string' ? data.faviconDataUrl : null,
      typeof data.faviconUrl === 'string' ? data.faviconUrl : null,
      row.created_at,
      row.updated_at,
    )
  }
  sqlite.prepare("DELETE FROM workspace_resources WHERE type = 'bookmark'").run()
}

function migrateWorkspaceFolders(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspace_folders (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES workspace_folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      collapsed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT ${nowMs},
      updated_at INTEGER NOT NULL DEFAULT ${nowMs},
      archived_at INTEGER
    );
  `)

  const workspaceColumns = [
    ['folder_id', 'TEXT REFERENCES workspace_folders(id) ON DELETE SET NULL'],
    ['position', 'INTEGER NOT NULL DEFAULT 0'],
    ['name_source', "TEXT NOT NULL DEFAULT 'explicit'"],
    ['source_kind', 'TEXT'],
    ['source_path', 'TEXT'],
  ] as const

  for (const [name, definition] of workspaceColumns) {
    if (!columnExists(sqlite, 'workspaces', name)) sqlite.exec(`ALTER TABLE workspaces ADD COLUMN ${name} ${definition}`)
  }

  const rows = sqlite.prepare(`
    SELECT id FROM workspaces
    WHERE archived_at IS NULL
    ORDER BY COALESCE(last_opened_at, -1) DESC, created_at DESC, id ASC
  `).all() as Array<{ id: string }>
  const update = sqlite.prepare(`
    UPDATE workspaces
    SET folder_id = NULL, position = ?, name_source = 'explicit'
    WHERE id = ?
  `)
  rows.forEach((row, position) => update.run(position, row.id))
}

function migrateSystemWorkspaces(sqlite: Database.Database) {
  const workspaceColumns = [
    ['kind', "TEXT NOT NULL DEFAULT 'user'"],
    ['system_key', 'TEXT'],
    ['hidden', 'INTEGER NOT NULL DEFAULT 0'],
    ['protected', 'INTEGER NOT NULL DEFAULT 0'],
  ] as const

  for (const [name, definition] of workspaceColumns) {
    if (!columnExists(sqlite, 'workspaces', name)) sqlite.exec(`ALTER TABLE workspaces ADD COLUMN ${name} ${definition}`)
  }
  sqlite.exec('CREATE UNIQUE INDEX IF NOT EXISTS workspaces_system_key_unique ON workspaces(system_key);')
}

export function runLocalAppMigrations(sqlitePath: string): LocalAppMigrationResult {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })
  const sqlite = new Database(sqlitePath)
  const applied: string[] = []
  try {
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    installMigrationRealtimeNotifyNoop(sqlite)
    const hasMigrations = tableExists(sqlite, 'schema_migrations')
    const migrationName = '0001_local_app_schema'
    const migrationAlreadyApplied =
      hasMigrations && sqlite.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(migrationName)

    if (!migrationAlreadyApplied) {
      sqlite.transaction(() => {
        sqlite.exec(localSchemaSql)
        sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(migrationName)
      })()
      applied.push(migrationName)
    }

    const workspaceStateMigrationName = '0002_normalized_workspace_state'
    const workspaceStateMigrationAlreadyApplied = sqlite
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get(workspaceStateMigrationName)
    if (!workspaceStateMigrationAlreadyApplied) {
      sqlite.transaction(() => {
        migrateWorkspaceUiStateBlob(sqlite)
        sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(workspaceStateMigrationName)
      })()
      applied.push(workspaceStateMigrationName)
    }

    const workspaceAgentTabsMigrationName = '0003_workspace_agent_tabs'
    const workspaceAgentTabsMigrationAlreadyApplied = sqlite
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get(workspaceAgentTabsMigrationName)
    if (!workspaceAgentTabsMigrationAlreadyApplied) {
      sqlite.transaction(() => {
        migrateWorkspaceAgentTabs(sqlite)
        sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(workspaceAgentTabsMigrationName)
      })()
      applied.push(workspaceAgentTabsMigrationName)
    }

    const workspaceFoldersMigrationName = '0004_workspace_folders'
    const workspaceFoldersMigrationAlreadyApplied = sqlite
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get(workspaceFoldersMigrationName)
    if (!workspaceFoldersMigrationAlreadyApplied) {
      sqlite.transaction(() => {
        migrateWorkspaceFolders(sqlite)
        sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(workspaceFoldersMigrationName)
      })()
      applied.push(workspaceFoldersMigrationName)
    }

    const agentNotificationsMigrationName = '0005_agent_notifications'
    const agentNotificationsMigrationAlreadyApplied = sqlite
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get(agentNotificationsMigrationName)
    if (!agentNotificationsMigrationAlreadyApplied) {
      sqlite.transaction(() => {
        migrateAgentNotifications(sqlite)
        sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(agentNotificationsMigrationName)
      })()
      applied.push(agentNotificationsMigrationName)
    }

    const agentNotificationTitlesMigrationName = '0006_agent_notification_titles'
    const agentNotificationTitlesMigrationAlreadyApplied = sqlite
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get(agentNotificationTitlesMigrationName)
    if (!agentNotificationTitlesMigrationAlreadyApplied) {
      sqlite.transaction(() => {
        migrateAgentNotificationTitles(sqlite)
        sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(agentNotificationTitlesMigrationName)
      })()
      applied.push(agentNotificationTitlesMigrationName)
    }

    const agentNotificationKindsMigrationName = '0007_agent_notification_kinds'
    const agentNotificationKindsMigrationAlreadyApplied = sqlite
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get(agentNotificationKindsMigrationName)
    if (!agentNotificationKindsMigrationAlreadyApplied) {
      sqlite.transaction(() => {
        migrateAgentNotificationKinds(sqlite)
        sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(agentNotificationKindsMigrationName)
      })()
      applied.push(agentNotificationKindsMigrationName)
    }

    const workspaceResourcesMigrationName = '0008_workspace_resources'
    const workspaceResourcesMigrationAlreadyApplied = sqlite
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get(workspaceResourcesMigrationName)
    if (!workspaceResourcesMigrationAlreadyApplied) {
      sqlite.transaction(() => {
        migrateWorkspaceResources(sqlite)
        sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(workspaceResourcesMigrationName)
      })()
      applied.push(workspaceResourcesMigrationName)
    }

    const workspaceTabTitleSourceMigrationName = '0009_workspace_tab_title_source'
    const workspaceTabTitleSourceMigrationAlreadyApplied = sqlite
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get(workspaceTabTitleSourceMigrationName)
    if (!workspaceTabTitleSourceMigrationAlreadyApplied) {
      sqlite.transaction(() => {
        migrateWorkspaceTabTitleSource(sqlite)
        sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(workspaceTabTitleSourceMigrationName)
      })()
      applied.push(workspaceTabTitleSourceMigrationName)
    }

    const faviconCacheMigrationName = '0010_favicon_cache'
    const faviconCacheMigrationAlreadyApplied = sqlite
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get(faviconCacheMigrationName)
    if (!faviconCacheMigrationAlreadyApplied) {
      sqlite.transaction(() => {
        migrateFaviconCache(sqlite)
        sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(faviconCacheMigrationName)
      })()
      applied.push(faviconCacheMigrationName)
    }

    const bookmarksMigrationName = '0011_bookmarks'
    const bookmarksMigrationAlreadyApplied = sqlite
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get(bookmarksMigrationName)
    if (!bookmarksMigrationAlreadyApplied) {
      sqlite.transaction(() => {
        migrateBookmarks(sqlite)
        sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(bookmarksMigrationName)
      })()
      applied.push(bookmarksMigrationName)
    }

    const systemWorkspacesMigrationName = '0012_system_workspaces'
    const systemWorkspacesMigrationAlreadyApplied = sqlite
      .prepare('SELECT 1 FROM schema_migrations WHERE name = ?')
      .get(systemWorkspacesMigrationName)
    if (!systemWorkspacesMigrationAlreadyApplied) {
      sqlite.transaction(() => {
        migrateSystemWorkspaces(sqlite)
        sqlite.prepare('INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)').run(systemWorkspacesMigrationName)
      })()
      applied.push(systemWorkspacesMigrationName)
    }

    return { sqlitePath, applied }
  } finally {
    sqlite.close()
  }
}

export const localAppTables = [
  'admin',
  'web_sessions',
  'secrets',
  'workspaces',
  'workspace_folders',
  'workspace_ui_states',
  'workspace_view_states',
  'workspace_tabs',
  'workspace_agent_tabs',
  'workspace_resources',
  'bookmarks',
  'favicon_cache',
  'agent_notifications',
  'sandboxes',
  'github_install',
  'github_token_cache',
  'repo_configs',
  'repo_config_files',
  'repos',
  'jobs',
  'shell_sessions',
  'agent_shell_tokens',
  'agent_sessions',
  'agent_transcripts',
  'env_auth_tokens',
  'env_auth_device_requests',
  'envs',
  'event_logs',
] as const
